# Versionamento, lançamento e volta atrás

## Branches

| branch | o que é |
|---|---|
| `main` | **produção**: o que está no APK lançado e no servidor. Cada push em `backend/**` faz deploy da API. |
| `develop` | a próxima versão em construção. Não faz deploy de nada. |
| `feature/*` | um trabalho de cada vez, com PR para `develop`. |

A `main` só recebe um merge de `develop` quando a versão está pronta para o celular.
Assim o servidor da versão estável não muda enquanto a próxima está em obras.

## Números de versão

- **`version` no `app.json`** (`versionName`): o que aparece em Ajustes e nas
  configurações do Android. `1.0.1` é a estável; `develop` já está em `1.1.0`.
- **`versionCode`**: controlado pelo EAS (`appVersionSource: remote`) e mantido **fixo
  em 2 no perfil `preview`**. É de propósito: o Android só instala por cima um APK com
  `versionCode` igual ou maior. Com o mesmo número em todos os APKs internos, a 1.0 instala
  por cima da 1.1 **sem desinstalar e sem perder os dados**. Não ligue `autoIncrement` no
  `preview`. (O perfil `production`, para a Play Store, incrementa — lá voltar de versão é
  outro processo.)
- **`runtimeVersion`** (política `fingerprint`): muda quando a versão ou algo nativo
  muda. Consequência boa: um `eas update` feito com o código da 1.1 **nunca chega** a um
  celular com o APK da 1.0, e vice-versa.

## Lançar uma versão

1. PR de `develop` para `main`, com testes, typecheck e lint passando.
2. Merge. Se houver mudança em `backend/**`, o workflow faz o deploy da API sozinho.
3. Tag na `main`: `git tag -a v1.1.0 -m "Spendr 1.1"` e `git push origin v1.1.0`.
4. Build do APK:

   ```bash
   npx eas-cli build --platform android --profile preview
   ```

5. Guarde o APK em `releases/spendr-vX.Y.Z.apk` (a pasta fica fora do git) e anote a tag
   no `CHANGELOG.md`.
6. Em `develop`, suba o `version` do `app.json` para a próxima versão.

## Voltar para a versão anterior

**O app.** Instale o APK guardado por cima do atual:

```bash
adb install -r releases/spendr-v1.0.1.apk
```

(ou copie o arquivo para o celular e abra). Mesmo `versionCode`, mesma assinatura: instala
por cima e os dados ficam. **Isso vale só entre APKs do EAS**: o EAS assina todos com a mesma chave,
guardada nele. Um APK gerado na máquina (`npm run build:apk`) usa o `prod.keystore` local, e o
Android recusa instalar um por cima do outro sem desinstalar — o que apagaria os dados locais. O banco aceita a volta: a versão antiga vê que o banco já está
numa versão mais nova, não roda migração nenhuma e ignora as tabelas que não conhece. De
volta na versão nova, tudo o que foi criado nela continua lá.

**O servidor.** As mudanças de backend são sempre **aditivas** (coleções e colunas novas e
opcionais), então a API nova atende o app antigo e raramente precisa voltar. Se precisar:
`git revert` do merge na `main` e push — o workflow faz o deploy da versão anterior. As
tabelas novas ficam no banco, sem uso.

## Regras para a versão nova não impedir a volta

- Migração do banco local e do Postgres **só acrescenta**: tabela nova, coluna nova
  anulável. Nunca renomear, apagar ou mudar o sentido de uma coluna que a versão anterior lê.
- Coleção nova no sync é **opcional** nos dois lados (`SyncChanges` e zod), como
  `accounts` e `retirementGoals` já são.
- O cursor do pull é guardado **por versão do banco**: a versão antiga não conhece as
  coleções novas e, se dividissem o cursor, avançaria o das coleções novas sem gravar as
  linhas.
