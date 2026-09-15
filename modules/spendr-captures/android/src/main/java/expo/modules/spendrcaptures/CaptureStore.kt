package expo.modules.spendrcaptures

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * Fila em disco entre o serviço de notificações e o JavaScript.
 *
 * O serviço roda quando o app pode nem estar aberto (o JS pode não existir naquele
 * momento), então ele só anota a notificação num arquivo e segue. Quem interpreta é o
 * app, na próxima vez que estiver de pé: `drain()` devolve tudo e esvazia o arquivo.
 * Uma linha por notificação, em JSON, para que uma linha corrompida não derrube as outras.
 */
object CaptureStore {
  private const val FILE_NAME = "spendr_captures.jsonl"

  /** Acima disto o arquivo é aparado: o app não abre há muito, e a fila não cresce sem fim. */
  private const val MAX_BYTES = 512L * 1024L
  private const val KEEP_LINES_WHEN_TRIMMING = 1000

  private val lock = Any()

  private fun file(context: Context): File = File(context.filesDir, FILE_NAME)

  fun append(context: Context, entry: JSONObject) {
    synchronized(lock) {
      val target = file(context)
      if (target.exists() && target.length() > MAX_BYTES) {
        val kept = target.readLines().takeLast(KEEP_LINES_WHEN_TRIMMING)
        target.writeText(kept.joinToString(separator = "\n", postfix = "\n"))
      }
      target.appendText(entry.toString() + "\n")
    }
  }

  /** Tudo que foi anotado desde o último `drain`, na ordem de chegada. Esvazia a fila. */
  fun drain(context: Context): List<Map<String, String>> {
    synchronized(lock) {
      val target = file(context)
      if (!target.exists()) return emptyList()

      val entries = target.readLines().mapNotNull { line -> parseLine(line) }
      target.delete()
      return entries
    }
  }

  fun pendingCount(context: Context): Int {
    synchronized(lock) {
      val target = file(context)
      return if (target.exists()) target.readLines().count { it.isNotBlank() } else 0
    }
  }

  private fun parseLine(line: String): Map<String, String>? {
    if (line.isBlank()) return null
    return try {
      val json = JSONObject(line)
      mapOf(
        "id" to json.optString("id"),
        "packageName" to json.optString("packageName"),
        "appLabel" to json.optString("appLabel"),
        "title" to json.optString("title"),
        "text" to json.optString("text"),
        "postedAt" to json.optString("postedAt"),
      )
    } catch (e: Exception) {
      null
    }
  }
}
