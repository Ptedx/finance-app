package expo.modules.spendrcaptures

import android.app.Notification
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/**
 * Recebe toda notificação publicada no aparelho e guarda as que parecem dinheiro.
 *
 * O filtro aqui é propositalmente grosseiro — "tem um símbolo de moeda seguido de
 * número" — porque o serviço não deve conter regra de negócio: ela vive no JavaScript,
 * onde é testada. Notificações do próprio Spendr, resumos de grupo e notificações
 * permanentes (player de música, download) ficam de fora.
 *
 * Nada sai do aparelho por aqui. O texto vai para um arquivo interno do app e é lido
 * pelo próprio app; não há rede neste processo.
 *
 * Conexão, desconexão e descartes vão para o `DiagnosticsStore` (SPD-015): sem isso, uma
 * captura que parou ou um aviso de banco que o filtro jogou fora não deixam rastro.
 */
class CaptureListenerService : NotificationListenerService() {

  override fun onListenerConnected() {
    super.onListenerConnected()
    DiagnosticsStore.append(applicationContext, "listener_connected", data = mapOf("sdk" to Build.VERSION.SDK_INT))
  }

  /**
   * O Android não diz por que desvinculou. O que dá para saber é se o acesso continua
   * ligado: desligado, foi o usuário; ligado, foi o sistema (atualização do app, economia de
   * bateria, processo morto) — e aí se pede para vincular de novo, senão a captura para em
   * silêncio até o próximo reinício do aparelho (AUTO-02).
   */
  override fun onListenerDisconnected() {
    super.onListenerDisconnected()
    val stillEnabled = isEnabled(applicationContext)
    DiagnosticsStore.append(
      applicationContext,
      "listener_disconnected",
      level = "warn",
      data = mapOf("reason" to if (stillEnabled) "system_unbound" else "access_revoked"),
    )
    if (stillEnabled) requestRebindLogged()
  }

  private fun requestRebindLogged() {
    val result = if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) "unsupported" else try {
      NotificationListenerService.requestRebind(ComponentName(applicationContext, CaptureListenerService::class.java))
      "ok"
    } catch (e: Exception) {
      e.javaClass.simpleName
    }
    DiagnosticsStore.append(applicationContext, "rebind_requested", data = mapOf("result" to result))
  }

  override fun onNotificationPosted(sbn: StatusBarNotification) {
    val pkg = sbn.packageName
    if (pkg == packageName) return
    val notification = sbn.notification ?: return dropped(pkg, "no_notification")
    if (notification.flags and Notification.FLAG_GROUP_SUMMARY != 0) return dropped(pkg, "group_summary")
    if (sbn.isOngoing) return dropped(pkg, "ongoing")

    val extras = notification.extras ?: return dropped(pkg, "no_extras")
    val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
    val body = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)
      ?: extras.getCharSequence(Notification.EXTRA_TEXT)
    val text = body?.toString().orEmpty()

    if (title.isBlank() && text.isBlank()) return dropped(pkg, "empty")
    if (!AMOUNT.containsMatchIn("$title $text")) return dropped(pkg, "no_amount", "$title\n$text")

    val entry = JSONObject()
      .put("id", UUID.randomUUID().toString())
      .put("packageName", sbn.packageName)
      .put("appLabel", appLabel(sbn.packageName))
      .put("title", title)
      .put("text", text)
      .put("postedAt", isoInstant(sbn.postTime))

    CaptureStore.append(applicationContext, entry)

    // Avisa o app, se ele estiver de pé, para a caixa de entrada atualizar na hora.
    // Broadcast restrito ao próprio pacote: ninguém de fora recebe nem forja.
    sendBroadcast(Intent(ACTION_CAPTURED).setPackage(packageName))
  }

  /**
   * Um aviso que o filtro deixou de fora. De banco conhecido, com texto ("empty"/"no_amount"),
   * vira linha com o pacote e o texto com os dígitos trocados por `#` (DEC-11 b): aviso de
   * banco sem valor costuma ser código de segurança, e o formato basta para entender o
   * filtro. O resto (resumo de grupo, permanente, qualquer app que não é banco) só conta.
   */
  private fun dropped(pkg: String, reason: String, raw: String? = null) {
    val bank = KnownBanks.contains(pkg)
    if (bank && (reason == "empty" || reason == "no_amount")) {
      DiagnosticsStore.append(
        applicationContext,
        "capture_dropped_by_filter",
        data = mapOf("package" to pkg, "reason" to reason),
        rawText = raw?.replace(DIGIT, "#"),
      )
    } else {
      DiagnosticsStore.countDrop(if (bank) "bank" else "other", reason)
    }
  }

  private fun appLabel(pkg: String): String = try {
    val pm = packageManager
    pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
  } catch (e: Exception) {
    pkg
  }

  private fun isoInstant(millis: Long): String {
    val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
    format.timeZone = TimeZone.getTimeZone("UTC")
    return format.format(Date(millis))
  }

  companion object {
    const val ACTION_CAPTURED = "expo.modules.spendrcaptures.CAPTURED"

    // Moeda pelo código ("USD 15,99") também passa: é a lista `FOREIGN_CURRENCY_CODES` de
    // `app/utils/captureParser.ts`, e o teste do parser lê este regex daqui para conferir.
    private val AMOUNT =
      Regex("""(?:R\$|US\$|\$|€|£|\b(?:USD|EUR|GBP|ARS|CLP|UYU|PYG|MXN|CAD|AUD|CHF|JPY))\s?\d""")

    private val DIGIT = Regex("""\d""")

    /**
     * O Android guarda os listeners autorizados numa lista "pacote/serviço:pacote/serviço".
     * Não há API pública mais direta que funcione em todas as versões suportadas.
     */
    fun isEnabled(context: Context): Boolean {
      val enabled = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners")
        ?: return false
      val pkg = context.packageName
      return enabled.split(":").any { it == pkg || it.startsWith("$pkg/") }
    }
  }
}
