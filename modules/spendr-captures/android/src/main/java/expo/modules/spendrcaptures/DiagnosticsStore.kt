package expo.modules.spendrcaptures

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/**
 * Diário do serviço de notificações, esperando o JavaScript (SPD-015).
 *
 * Mesmo esquema do `CaptureStore`: o serviço roda quando o app pode nem estar aberto, então
 * anota num arquivo interno, uma linha JSON por evento, e o app esvazia com `drain()` ao
 * abrir e ao voltar ao primeiro plano. O nativo não escreve no diário do JS.
 *
 * A fila é pequena e limitada: guarda os `MAX_ENTRIES` mais novos e descarta os mais velhos.
 * Os descartes de apps que não são banco não viram linha (seriam uma por mensagem de
 * WhatsApp): só somam num contador na memória, que sai como um evento por motivo no
 * próximo `drain()`. Morrendo o processo, a contagem se perde; é só um indício.
 */
object DiagnosticsStore {
  private const val FILE_NAME = "spendr_diagnostics.jsonl"
  private const val MAX_ENTRIES = 200
  private const val MAX_RAW_TEXT = 2000

  private val lock = Any()

  /** Descartes sem linha própria, por "escopo/motivo" ("other/no_amount"), desde o último drain. */
  private val dropCounts = linkedMapOf<String, Int>()
  private var countingSince: String? = null

  private fun file(context: Context): File = File(context.filesDir, FILE_NAME)

  fun append(
    context: Context,
    event: String,
    level: String = "info",
    data: Map<String, Any?> = emptyMap(),
    rawText: String? = null,
  ) {
    val entry = JSONObject()
      .put("id", UUID.randomUUID().toString())
      .put("at", now())
      .put("level", level)
      .put("event", event)
      .put("data", JSONObject(data))
    if (!rawText.isNullOrBlank()) entry.put("rawText", rawText.take(MAX_RAW_TEXT))

    try {
      synchronized(lock) {
        val target = file(context)
        val kept = if (target.exists()) target.readLines().filter { it.isNotBlank() } else emptyList()
        if (kept.size >= MAX_ENTRIES) {
          val trimmed = kept.takeLast(MAX_ENTRIES - 1) + entry.toString()
          target.writeText(trimmed.joinToString(separator = "\n", postfix = "\n"))
        } else {
          target.appendText(entry.toString() + "\n")
        }
      }
    } catch (e: Exception) {
      // Diário nunca derruba o serviço: sem disco, o evento se perde e a captura segue.
    }
  }

  /** Conta um descarte sem gravar linha (ver o cabeçalho). */
  fun countDrop(scope: String, reason: String) {
    synchronized(lock) {
      if (countingSince == null) countingSince = now()
      val key = "$scope/$reason"
      dropCounts[key] = (dropCounts[key] ?: 0) + 1
    }
  }

  /** Tudo desde o último `drain`, uma linha JSON por evento, na ordem de chegada. Esvazia. */
  fun drain(context: Context): List<String> {
    synchronized(lock) {
      val target = file(context)
      val lines = try {
        if (target.exists()) target.readLines().filter { it.isNotBlank() } else emptyList()
      } catch (e: Exception) {
        emptyList()
      }
      target.delete()

      val since = countingSince
      val counted = dropCounts.map { (key, count) ->
        val (scope, reason) = key.split("/", limit = 2).let { it[0] to it.getOrElse(1) { "" } }
        JSONObject()
          .put("id", UUID.randomUUID().toString())
          .put("at", now())
          .put("level", "debug")
          .put("event", "capture_dropped_by_filter")
          .put("data", JSONObject(mapOf("scope" to scope, "reason" to reason, "count" to count, "since" to since)))
          .toString()
      }
      dropCounts.clear()
      countingSince = null

      return lines + counted
    }
  }

  private fun now(): String {
    val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
    format.timeZone = TimeZone.getTimeZone("UTC")
    return format.format(Date())
  }
}
