package expo.modules.spendrcaptures

/**
 * Apps de banco conhecidos, pelo nome do pacote.
 *
 * É a fronteira da DEC-11 (b): o diário só guarda texto de notificação que vem de um destes
 * apps. Mensageiro, e-mail e qualquer outro app ficam só com contagem, sem pacote nem texto.
 *
 * A mesma lista existe em `app/diagnostics/knownBanks.ts`; o teste de lá lê esta para as
 * duas não divergirem. Banco que falta aqui não perde captura: o filtro de captura não usa
 * esta lista, só o diário.
 */
object KnownBanks {
  val PACKAGES = setOf(
    "com.nu.production",
    "br.com.intermedium",
    "br.com.inter.pj",
    "com.itau",
    "br.com.itau.personnalite",
    "com.bradesco",
    "br.com.bradesco.next",
    "com.santander.app",
    "br.com.bb.android",
    "br.com.gabba.Caixa",
    "com.c6bank.app",
    "com.picpay",
    "com.mercadopago.wallet",
    "br.com.neon",
    "br.com.uol.ps.myaccount",
  )

  fun contains(packageName: String): Boolean = packageName in PACKAGES
}
