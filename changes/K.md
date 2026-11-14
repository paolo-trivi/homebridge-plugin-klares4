# K — CI, release, packaging

File toccati: `.github/**`, `tsconfig.json`, `package.json` (solo `files`, script nuovi o di packaging/CI), `scripts/release-guard.js`, `scripts/check-pack.js` e `scripts/clean-dist.js` (nuovi), test `test/release-guard.test.js` e `test/check-pack.test.js` (nuovi). Nessuna chiave di config, nessun cambio di comportamento del plugin a runtime. `engines` non è cambiato (vedi G-08).

Nota per chi integra: `scripts/` è nel `.gitignore` (riga `scripts/`), i tre file nuovi sono stati aggiunti con `git add -f`. Il `.gitignore` non è di K: conviene sostituire `scripts/` con le sole voci locali (`scripts/reverse/`, `scripts/debug-thermostat-routing.js`, già presenti) altrimenti ogni futuro script richiede `-f`.

## Cosa fa ora la pipeline

### `ci.yml`
| Job | Nome del check | Cosa esegue |
|---|---|---|
| `validate` | `Validate (Node 22)`, `Validate (Node 24)`, `Validate (Node 26)` | `npm ci --ignore-scripts`, `npm run verify` (max-lines, tsc strict, suite compresi i test di contratto con l'Homebridge del lockfile). I nomi 22 e 24 sono quelli dei check obbligatori attuali. |
| `engines-floor` | `Engines floor (Node 22.12.0)` | stesso `verify` sul limite inferiore di `engines.node` |
| `contract` | `Contract (Homebridge 2.4.x)`, `Contract (Homebridge 2.5.x)` | installa Homebridge `~2.4.0` / `~2.5.0` in `node_modules` senza salvare (`npm install --no-save --no-package-lock`), poi `npm run test:contract` su Node 26. Non è `continue-on-error`. |
| `coverage` | `Coverage` | `npm run test:coverage` su Node 22, con soglie (sotto) |
| `package` | `Package` | `npm run check:pack`: `npm pack` con build di release e verifica del tarball contro una allowlist |

Tutte le action sono pinnate per SHA con la versione esatta nel commento (`actions/checkout` v7.0.1, `actions/setup-node` v7.1.0, `actions/upload-artifact` v7.0.2, `actions/download-artifact` v8.0.2, `dependabot/fetch-metadata` v3.1.0; per i tag che puntavano a un oggetto tag annotato lo SHA è quello del commit). `persist-credentials: false` su ogni checkout e `npm ci --ignore-scripts` ovunque (nessuna dipendenza ha bisogno di script di install; verificato con build e suite complete).

**Il nuovo check `Validate (Node 26)` va aggiunto alla protezione di `main`** (vedi sotto: i check obbligatori sono solo `Validate (Node 22)` e `Validate (Node 24)`).

Soglie di copertura (nello script `test:coverage`, vale per ogni esecuzione): righe 88, rami 83, funzioni 88, solo `src/` (`test/**` e `scripts/**` esclusi). Misura su questa base (Node 22.19, 643 test): righe 90,72, rami 85,73, funzioni 91,04. Margine di circa 3 punti: l'ondata 1 aggiunge molto codice e rimuove la telemetria, quindi la soglia va rimisurata su `release/2.3.0` dopo i merge e alzata (ratchet) a 2 punti sotto la misura. `node --test` accetta soglie solo globali: non esiste una soglia per file critico.

### `release-publish.yml` (tag `v*`)
Due job, permessi di default nulli:
1. `build` (`contents: read`, nessun `id-token`): checkout con storia completa; il commit del tag deve essere antenato di `origin/main` (`git merge-base --is-ancestor`); `scripts/release-guard.js`; `npm ci --ignore-scripts`; `npm run verify`; `npm pack` (prepack = build di release senza source map); `scripts/check-pack.js` sul tarball; `SHA256SUMS`; upload del tarball come artifact (`release-tarball`, 7 giorni). Non usa la cache npm.
2. `publish` (`needs: build`, `environment: npm-publish`, `contents: read` + `id-token: write`): non fa checkout e non esegue codice del repository né delle dipendenze. Scarica l'artifact, verifica lo SHA-256 e che nome/versione nel tarball coincidano con quelli del job `build`, ricontrolla (dopo l'eventuale attesa dell'approvazione) che il commit sia ancora su `main` (`gh api compare`) e che la versione non sia stata pubblicata, poi `npm publish <tarball> --tag … --access public --provenance`.

`scripts/release-guard.js` (testato in `test/release-guard.test.js`):
- tag git = `v<version>`; versione ammessa solo `X.Y.Z`, `X.Y.Z-rc.N`, `X.Y.Z-beta.N` (prima qualunque altro suffisso, es. `-alpha.1`, finiva su `latest`);
- versione già pubblicata → errore;
- dist-tag: `latest` / `rc` / `beta`;
- **una stable `X.Y.Z` richiede una `X.Y.Z-rc.N` pubblicata (`npm view`), il tag git `vX.Y.Z-rc.N` presente, e nessuna differenza tra l'rc più recente e la stable in `package-lock.json` e nei campi `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`, `overrides` di `package.json`.**

### Regola di rilascio (G-02), per la documentazione contributori
> A stable release must be the build that was validated as a release candidate. Publish `X.Y.Z-rc.N`, validate it on a real installation, then tag `vX.Y.Z` on the same dependencies. A runtime-dependency major, a compiler major (TypeScript) or any other lockfile change after the last rc requires a new rc. The release workflow enforces this: it refuses a stable without a published rc of the same base version, or whose lockfile or dependency fields differ from that rc.

La regola è applicata in forma più rigida di "major di dipendenza runtime o di compilatore": qualunque modifica al lockfile dopo l'ultima rc impone una nuova rc (una patch di Dependabot tra rc e stable costringe a una rc.N+1). È voluto: il guasto di G-02 era un cambio di dipendenze tra rc.4 e stable, e distinguere "major" dal lockfile richiederebbe un parser di semver senza dare garanzie in più. Se la rigidità pesa, l'alternativa è confrontare solo `dependencies` e la versione di `typescript`.

Procedura (da `RELEASING`/docs contributori): PR di bump di `package.json` e `CHANGELOG.md` su `main` → `git tag vX.Y.Z-rc.1 && git push origin vX.Y.Z-rc.1` → approvare il deployment `npm-publish` in Actions → validazione sul campo → per la stable ripetere con `vX.Y.Z` senza toccare dipendenze.

### `dependabot-auto-merge.yml`
- Esegue solo se `github.event.pull_request.user.login == 'dependabot[bot]'` (autore della PR, non `github.actor`, che cambia a chi riesegue il job) e il ramo è del repository stesso.
- `permissions: {}` a livello di workflow, `contents: write` e `pull-requests: write` solo nel job; nessun checkout.
- Auto-merge solo se **ogni** dipendenza di `updated-dependencies-json` è patch o minor E (`direct:development` oppure ecosistema `github_actions`). Le dipendenze runtime, gli aggiornamenti major e le indirette non vengono auto-unite: la PR resta aperta per la review.
- `dependabot.yml`: gruppi separati `npm-dev-minor-and-patch` e `npm-runtime-minor-and-patch`, così le PR delle dipendenze runtime non si mescolano a quelle di sviluppo; gli aggiornamenti delle action (`github-actions`, gruppo `actions-minor-and-patch`) continuano e riscrivono sia lo SHA sia il commento con la versione.

## Packaging (G-06, TD-Q-03)

Decisione: le source map **non vengono pubblicate**. `src/` non è nel pacchetto e una map completa richiederebbe `inlineSources` (sorgenti duplicati nel tarball) per un beneficio nullo: Homebridge non avvia Node con `--enable-source-maps`, quindi nessun utente le userebbe. Alternativa scartata: `sourceMap` + `inlineSources` in `build:release` e rimozione di `!dist/**/*.map` (costa circa +0,5 MB in chiaro).
- `tsconfig.json`: `declarationMap` rimosso (puntava a `src`); `declaration` resta; `sourceMap` resta perché `test:coverage` misura la copertura per file di `src/` tramite le map di `dist/`.
- `files`: `"!dist/**/*.map"`.
- `prebuild` (`scripts/clean-dist.js`, solo Node, nessuna dipendenza) svuota `dist/` prima di ogni `npm run build`, quindi anche prima di `npm test`, `test:contract`, `test:coverage`, `verify`: tsc non cancella mai l'output di un sorgente rimosso e un `.js` orfano (successo con `telemetry.js` dopo il task I) veniva testato e sarebbe stato pubblicato. Il significato degli script `test*` non cambia.
- `build:release` = `npm run build -- --sourceMap false` (quindi parte da `dist/` pulita), quindi anche i `.js` non hanno più il commento `//# sourceMappingURL`. `prepack` lo esegue: `npm pack` e `npm publish` da cartella producono sempre il tarball pulito, qualunque sia lo stato di `dist/`. `prepublishOnly` rimosso (con il tarball già pronto non viene eseguito, e `prepack` lo sostituisce).
- `check:pack` (`scripts/check-pack.js [tarball]`): allowlist (`dist/**`, `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, `config.schema.json`), nessun `.map`, nessun `sourceMappingURL` nei `.js`, `main` e `dist/index.d.ts` presenti, `config.schema.json` JSON valido, nessuno script `preinstall`/`install`/`postinstall`, **nessun file `dist/**/*.js` o `*.d.ts` senza il sorgente corrispondente in `src/`** (build non pulita). La verifica gira nel job `build` del release e nel job `Package` della CI (richiede `src/` nel checkout). Verificato in negativo: un `dist/` con un modulo orfano viene rifiutato e `npm run build` lo elimina; un tarball da build di sviluppo (con map) viene rifiutato.
- Risultato (`npm pack --dry-run --json`): da 521 file, 345.634 byte compressi, 1.495.480 byte decompressi (258 `.map`) a 263 file, 240.499 byte, 941.717 byte (129 `.js`, 129 `.d.ts`, 5 file di radice).
- `target` ES2022, `lib` ES2023 (Node 22 li supporta per intero), con `useDefineForClassFields: false` per conservare la semantica di emissione dei campi di classe di ES2020. Confrontato l'output di `tsc` prima/dopo: solo separatori numerici (`60_000`) e un `static { }` al posto dell'assegnazione statica in `command-dispatcher.js`; nessun altro cambio. Suite verde senza altre modifiche di codice. Lasciato al task Qualità dell'ondata 3: `noUncheckedIndexedAccess` (20 errori), `exactOptionalPropertyTypes` (61), `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noImplicitReturns` (0 errori, attivabili subito).
- Script rimossi: `release:rc` e `release:beta` (pubblicavano da una macchina locale, senza provenance e senza il gate dell'environment: ora si pubblica solo con il tag). `release:dry-run` resta.

## G-08: `engines`

- `engines.node` resta `>=22.12.0`. L'incoerenza segnalata (Node 23.0–23.1) veniva solo da `@sentry/node` 11 (`>=22.12.0 <23.0.0 || >=23.2.0`), che il task I rimuove. Ho controllato nel lockfile gli `engines.node` di tutte le dipendenze non di sviluppo: nessun'altra esclude versioni sopra 22.12. Il limite inferiore è esercitato: suite completa (`npm run verify`) eseguita in locale con Node 22.12.0 e job CI `Engines floor`.
- `engines.homebridge` resta `^1.6.0 || ^2.0.0-beta.0`: **decisione da confermare**. Nessun test né job CI esercita Homebridge 1.x (la suite usa `@homebridge/hap-nodejs` e lo stack Matter di Homebridge 2.x; il codice `src/` usa Homebridge solo come API a runtime). Restringere a `^2.0.0-beta.0` sarebbe l'unico modo di rendere `engines` veritiero, ma toglierebbe il plugin a chi è ancora su 1.x e il README promette `>= 1.6.0`. Scelta conservativa: invariato, con la dichiarazione "1.x non testato" da mettere nel README (task documentazione). Alternativa: cambiare la riga `engines.homebridge` in `^2.0.0-beta.0`.

## G-03 / TD-Q-06

Node 26 è nella matrice. Suite completa (`npm run verify`, 648 test: 643 pass, 0 fail, 5 todo) eseguita in locale, con tsconfig ES2022, su Node 22.12.0, 24.22.3 e 26.13.1 (binari installati in una directory temporanea dal pacchetto npm `node`).

## Job di contratto su Homebridge 2.4.x: esito locale e cosa serve

Verificato in una copia fuori dal worktree (`npm ci`, `npm i --no-save homebridge@~2.4.0` → Homebridge 2.4.0, `@matter/main` 0.17.9, Node 22.19): **il job 2.4.x oggi fallisce, in modo leggibile** (14 test su 18 falliti con `light_1 is not on the bridge`, più il timeout del file perché lo stack non si chiude dopo l'asserzione fallita; il job ha `timeout-minutes: 15`).

Causa (verificata): i moduli che l'harness importa per percorso (`homebridge/dist/api.js`, `user.js`, `matter/server.js`, `matter/ChildBridgeMatterManager.js`, `BaseMatterManager.js`) esistono in 2.4.0 con la stessa forma. Cambia la semantica di `api.matter.registerPlatformAccessories` / `unregisterPlatformAccessories`: in 2.5.0 passano da `emitAndWait` (la promise si risolve quando l'endpoint esiste o è stato rimosso, `MatterAPIImpl.js:275, 350, 359`), in 2.4.0 emettono l'evento e tornano subito (`MatterAPIImpl.js:260, 325`), mentre il listener registra in modo asincrono. Il plugin ne è già consapevole (sonda di registrazione), l'harness no.

Per adattare l'harness (non è di K; task T0.1/E/F1, file `test/matter-real-stack-contract.test.js` e `test/fixtures/real-matter-stack.js`):
1. in `registerOnRealStack` e nello stesso modo per l'unregister, dopo la chiamata attendere con `waitFor` che `stack.record(uuid)` esista (o sparisca): con questa sola modifica, in copia, 15 test su 16 passano su 2.4.0 (compreso il riavvio con cache) e il `todo` TH-01 resta `todo`;
2. il test `fixture fidelity: the API calls behave as the fixture models them` codifica la semantica 2.5.0 ("register resolves once the endpoint exists", messaggio "already registered" nel log subito dopo la chiamata): va reso esplicito per versione (es. attesa su `hbLines`/`record`) oppure eseguito solo se la versione installata è 2.5.x, con il motivo scritto nel test;
3. `hb-matter-api.js` modella 2.5.0: il commento in testa deve dire che 2.4.0 non attende i listener;
4. il fix di E per TH-01 deve essere verificato anche su matter.js 0.17.9 (2.4.0): il job lo farà da solo.
Fino ad allora `Contract (Homebridge 2.4.x)` è rosso e non va aggiunto ai check obbligatori; `Contract (Homebridge 2.5.x)` è verde.

## Azioni manuali dell'utente (impostazioni GitHub e npm)

Non eseguite da K (sola lettura). Stato letto: repository pubblico, `main` protetto con check obbligatori `Validate (Node 22)` e `Validate (Node 24)` (strict), nessuna review obbligatoria, `enforce_admins` off, nessun ruleset, environment `npm-publish` senza regole (`can_admins_bypass: true`, nessuna policy sui rami), `allowed_actions: all`, `sha_pinning_required: false`, permessi di default del workflow in sola lettura. Il tuo user id GitHub è 43490693.

**Ordine:** prima merge di questo lavoro su `main` e una esecuzione di CI, poi i comandi (un check obbligatorio che non ha mai riportato uno stato blocca le PR).

`R=paolo-trivi/homebridge-plugin-klares4`

### 1. Check obbligatori su `main` (aggiunge `Validate (Node 26)` e gli altri)
Sostituisce l'intera protezione con quella attuale più i nuovi check (stessi valori di oggi per tutto il resto):
```bash
gh api -X PUT repos/$R/branches/main/protection --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "Validate (Node 22)",
      "Validate (Node 24)",
      "Validate (Node 26)",
      "Engines floor (Node 22.12.0)",
      "Contract (Homebridge 2.5.x)",
      "Coverage",
      "Package"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": false,
  "lock_branch": false,
  "allow_fork_syncing": false
}
EOF
```
Quando l'harness è adattato aggiungere `"Contract (Homebridge 2.4.x)"` alla lista.
Review obbligatoria per le dipendenze runtime (G-04): non l'ho inclusa. Una review richiesta su `main` bloccherebbe anche l'auto-merge delle dipendenze di sviluppo (il workflow non può approvare: `can_approve_pull_request_reviews` è false) e le PR dell'unico proprietario (non può approvarsi da solo; con `enforce_admins` off potrebbe forzare il merge). La garanzia attuale è che il workflow non abilita mai l'auto-merge per le dipendenze runtime: la PR resta aperta finché la unisci tu. Se vuoi comunque la regola: `"required_pull_request_reviews": {"required_approving_review_count": 1, "dismiss_stale_reviews": true}` nel body sopra.

### 2. Environment `npm-publish`: revisore obbligatorio, solo tag `v*`, niente bypass admin (G-01)
```bash
gh api -X PUT repos/$R/environments/npm-publish --input - <<'EOF'
{
  "wait_timer": 0,
  "prevent_self_review": false,
  "can_admins_bypass": false,
  "reviewers": [{ "type": "User", "id": 43490693 }],
  "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true }
}
EOF
gh api -X POST repos/$R/environments/npm-publish/deployment-branch-policies -f name='v*' -f type=tag
```
Da qui ogni publish resta in attesa finché approvi il deployment in Actions (Review deployments), dal browser: è l'approvazione fuori dalla macchina con il token `gh` a rendere reale il gate (il token del NUC, scope `repo` e `workflow`, può ancora spingere un tag ma non approvare il deployment al posto tuo se usi un altro dispositivo con 2FA). `prevent_self_review` è `false` perché sei l'unico utente: con `true` nessuno potrebbe approvare.

### 3. Ruleset sui tag `v*` (G-01)
Tag non cancellabili né spostabili dopo il push; creazione consentita solo ai ruoli admin.
```bash
gh api -X POST repos/$R/rulesets --input - <<'EOF'
{
  "name": "release-tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "rules": [
    { "type": "creation" },
    { "type": "update" },
    { "type": "deletion" },
    { "type": "non_fast_forward" }
  ],
  "bypass_actors": [
    { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }
  ]
}
EOF
```
Con il bypass admin `update`/`deletion` si possono ancora forzare da amministratore: se vuoi tag davvero immutabili togli `bypass_actors` (ma allora nemmeno tu potrai creare un tag `v*`: la regola `creation` va tolta insieme).

### 4. Action: solo SHA, solo quelle usate (G-04)
```bash
gh api -X PUT repos/$R/actions/permissions -F enabled=true -f allowed_actions=selected -F sha_pinning_required=true
gh api -X PUT repos/$R/actions/permissions/selected-actions \
  -F github_owned_allowed=true -F verified_allowed=false \
  -f 'patterns_allowed[]=dependabot/fetch-metadata@*'
```
Tutti i workflow del repository sono già pinnati per SHA e usano solo `actions/*` e `dependabot/fetch-metadata`; con `sha_pinning_required` un'action non pinnata in una PR futura fa fallire il workflow. Verifica dopo il merge che `Dependabot auto-merge` e `CI` partano.

### 5. Trusted publisher su npmjs.com (G-01, consigliato)
Su npmjs.com → pacchetto → Settings → Trusted Publisher: workflow `release-publish.yml`, **Environment name: `npm-publish`** (così il token OIDC è valido solo per le esecuzioni che passano dall'environment). Nello stesso pannello: "Require two-factor authentication and disallow tokens" per il pubblicare (la pubblicazione passa solo da OIDC). Il nome del file del workflow non è cambiato.

### 6. Dist-tag npm fermi (G-05)
Stato attuale: `latest` → 2.2.0, `rc` → 2.2.0-rc.4, `beta` → 2.0.1-beta2, `debug` → 1.1.7-debug0. `npm dist-tag` richiede login con 2FA (il publish OIDC non copre i dist-tag).
```bash
npm login
npm dist-tag rm homebridge-plugin-klares4 debug --otp=<codice>
npm dist-tag rm homebridge-plugin-klares4 beta --otp=<codice>
```
`debug` e `beta` sono rami abbandonati, precedenti alle correzioni di sicurezza: rimuoverli fa fallire `npm i …@beta`/`@debug` con un errore chiaro invece di installare codice vecchio. Se preferisci un tag che continui a esistere: `npm dist-tag add homebridge-plugin-klares4@<versione> beta --otp=<codice>`. `rc` si riallinea da solo alla prima `2.3.0-rc.N` pubblicata dal workflow; dopo la stable 2.3.0 puntarlo alla stable (`npm dist-tag add homebridge-plugin-klares4@2.3.0 rc --otp=<codice>`) o rimuoverlo, come preferisci. Verifica: `npm view homebridge-plugin-klares4 dist-tags --json`.

## G-09
In CI e nei worktree il problema non esiste (`npm ci` pulito su Linux). Il checkout principale `/root/smarthome/homebridge-plugin-klares4` contiene ancora `node_modules/@typescript/typescript-darwin-arm64` e nessun binario Linux: prima di compilare lì serve `rm -rf node_modules && npm ci`. Non toccato da K.

## Voci di changelog (EN)
Changed:
- The npm package no longer ships source maps (they pointed at sources that are not published): 263 files instead of 521, 240 kB instead of 346 kB.
- Compiled for ES2022 (Node 22 and later, as before).

Internal (omit or put under "Changed" for contributors):
- Releases are built and tested in a job without publish rights and published from the resulting tarball in a second job behind the `npm-publish` environment; the tagged commit must be on `main`; a stable release requires a published release candidate with the same dependencies.
- CI runs on Node 22, 24 and 26, runs the real Homebridge Matter stack contract tests on Homebridge 2.4.x and 2.5.x, enforces coverage thresholds and checks the package contents; all actions are pinned by commit SHA; Dependabot only auto-merges development dependencies and actions.

## Note per la documentazione (task L)
- `docs/` / contributori: `npm run check:pack`, `npm run build:release`, `npm run test:contract`, `npm run test:coverage` (con soglie), regola di rilascio e procedura (sopra), lista Node supportati 22, 24, 26 (TD-DOC-12), "Homebridge 1.x non testato" nel README.
- `ARCHITECTURE.md`: sezione release con i due job e il gate.
- Non ci sono cambi per `config.schema.json` né per il README utente oltre al requisito Homebridge 1.x.
