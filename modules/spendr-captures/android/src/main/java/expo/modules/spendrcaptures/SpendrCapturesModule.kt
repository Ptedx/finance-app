package expo.modules.spendrcaptures

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * A ponte JavaScript ↔ serviço de notificações.
 *
 * Quatro funções e um evento: saber se o acesso está ligado, abrir a tela do sistema
 * para ligá-lo, esvaziar a fila e contar o que há nela; o evento `onCaptured` avisa que
 * chegou notificação nova enquanto o app está aberto.
 */
class SpendrCapturesModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private var receiver: BroadcastReceiver? = null

  override fun definition() = ModuleDefinition {
    Name("SpendrCaptures")

    Events("onCaptured")

    Function("isEnabled") { isListenerEnabled() }

    Function("openSettings") {
      val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }

    Function("drain") { CaptureStore.drain(context) }

    Function("pendingCount") { CaptureStore.pendingCount(context) }

    OnStartObserving { registerReceiver() }
    OnStopObserving { unregisterReceiver() }
    OnDestroy { unregisterReceiver() }
  }

  /**
   * O Android guarda os listeners autorizados numa lista "pacote/serviço:pacote/serviço".
   * Não há API pública mais direta que funcione em todas as versões suportadas.
   */
  private fun isListenerEnabled(): Boolean {
    val enabled = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners")
      ?: return false
    val pkg = context.packageName
    return enabled.split(":").any { it == pkg || it.startsWith("$pkg/") }
  }

  private fun registerReceiver() {
    if (receiver != null) return

    val created = object : BroadcastReceiver() {
      override fun onReceive(ctx: Context?, intent: Intent?) {
        sendEvent("onCaptured", mapOf("pending" to CaptureStore.pendingCount(context)))
      }
    }

    val filter = IntentFilter(CaptureListenerService.ACTION_CAPTURED)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.registerReceiver(created, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      @Suppress("UnspecifiedRegisterReceiverFlag")
      context.registerReceiver(created, filter)
    }
    receiver = created
  }

  private fun unregisterReceiver() {
    val current = receiver ?: return
    receiver = null
    try {
      appContext.reactContext?.unregisterReceiver(current)
    } catch (e: Exception) {
      // Já removido ou contexto encerrado: nada a fazer.
    }
  }
}
