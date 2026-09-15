package expo.modules.spendrcaptures

import android.app.Notification
import android.content.Intent
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
 */
class CaptureListenerService : NotificationListenerService() {

  override fun onNotificationPosted(sbn: StatusBarNotification) {
    if (sbn.packageName == packageName) return
    val notification = sbn.notification ?: return
    if (notification.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
    if (sbn.isOngoing) return

    val extras = notification.extras ?: return
    val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
    val body = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)
      ?: extras.getCharSequence(Notification.EXTRA_TEXT)
    val text = body?.toString().orEmpty()

    if (title.isBlank() && text.isBlank()) return
    if (!AMOUNT.containsMatchIn("$title $text")) return

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
    private val AMOUNT = Regex("""(?:R\$|US\$|\$|€|£)\s?\d""")
  }
}
