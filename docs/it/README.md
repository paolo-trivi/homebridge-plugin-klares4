# Klares4 Docs (IT)

## Indice

1. [Panoramica del Plugin](./panoramica-plugin.md)
2. [Configurazione e UI](./configurazione-e-ui.md)
3. [Protocollo WebSocket](./protocollo-websocket.md)
4. [Termostati Domus e KSA](./termostati-domus.md)
5. [Bridge MQTT](./mqtt.md)
6. [Matter](./matter.md)
7. [Privacy e File di Debug](./privacy-e-file-di-debug.md)
8. [Operazioni e Risoluzione dei Problemi](./operazioni-debug.md)

## Ambito

Questi documenti descrivono come funziona oggi il plugin in produzione:

- ciclo di vita della piattaforma Homebridge e sincronizzazione
- lettura della configurazione, politica di esposizione e modulo delle impostazioni
- flussi WebSocket di richiesta/risposta/realtime, ciclo di vita dei comandi e protezione del login
- stato dei termostati e instradamento dei comandi
- comportamento del bridge MQTT, topic di disponibilità e sicurezza
- comportamento di Matter, termostati, identità, rimozione e risoluzione dei problemi
- import KSA e cache sanitizzata
- privacy, file di debug riservato e flusso di diagnostica

La versione inglese è in [`../en/`](../en/README.md), pagina per pagina. La mappa dei moduli è in [`ARCHITECTURE.md`](../../ARCHITECTURE.md), le modifiche visibili agli utenti sono in [`CHANGELOG.md`](../../CHANGELOG.md).
