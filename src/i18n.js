// -----------------------------------------------------------------------------
// The texts users read (status, action results, refusals, feature names), in
// English and French. A text never quotes a token, a password, a code nor
// anything typed by the user that was refused.
// -----------------------------------------------------------------------------

import { FEATURES } from './constants.js';

/** The text of a message in a language. */
export const word = (text, language) =>
  typeof text === 'string' ? text : (text?.[language] ?? text?.en ?? '');

const both = (en, fr) => ({ en, fr });
const MAX_STATUS = 600;

const NAMES = {
  [FEATURES.POWER]: both('Power (LED)', 'Alimentation (voyant)'),
  [FEATURES.HDD]: both('Disk activity (LED)', 'Activité disque (voyant)'),
  [FEATURES.TEMPERATURE]: both('PiKVM temperature', 'Température du PiKVM'),
  [FEATURES.POWER_ON]: both('Power on', 'Allumer'),
  [FEATURES.SHUTDOWN]: both('Shut down', 'Éteindre'),
  [FEATURES.FORCE_OFF]: both('Force power off', "Forcer l'extinction"),
  [FEATURES.RESET]: both('Reset', 'Reset'),
};

/** The name of a feature. */
export function featureName(key, language = 'fr') {
  const name = NAMES[key];
  return name ? word(name, language) : key;
}

const CONFIG_ERRORS = {
  empty: both(
    'Type the address of your PiKVM, the user name and password of its web interface, save, then click "Trust the certificate" twice.',
    "Saisissez l'adresse de votre PiKVM, l'identifiant et le mot de passe de son interface web, enregistrez, puis cliquez deux fois sur « Faire confiance au certificat ».",
  ),
  invalid: both('The PiKVM address is not valid.', "L'adresse du PiKVM n'est pas valide."),
  scheme: both(
    'The PiKVM answers in HTTPS only: type its address alone.',
    'Le PiKVM répond en HTTPS seulement : saisissez son adresse seule.',
  ),
  credentials: both(
    'No user name nor password in the address: use the fields below.',
    "Pas d'identifiant ni de mot de passe dans l'adresse : utilisez les champs ci-dessous.",
  ),
  path: both('Type the address alone, without a path.', "Saisissez l'adresse seule, sans chemin."),
  broadcast: both(
    'This address is not one of a device (broadcast or multicast).',
    "Cette adresse n'est pas celle d'un appareil (diffusion ou multicast).",
  ),
  'local-name': both(
    'Names in .local do not resolve in the container: type the IP address of the PiKVM.',
    "Les noms en .local ne sont pas résolus dans le conteneur : saisissez l'adresse IP du PiKVM.",
  ),
  fingerprint: both(
    'The certificate fingerprint is not a SHA-256 one (64 hexadecimal digits).',
    "L'empreinte du certificat n'est pas une SHA-256 (64 caractères hexadécimaux).",
  ),
  'no-credentials': both(
    'Type the user name and password of the PiKVM web interface.',
    "Saisissez l'identifiant et le mot de passe de l'interface web du PiKVM.",
  ),
  'no-username': both(
    'A password without a user name is refused: type the user name too.',
    "Un mot de passe sans identifiant est refusé : saisissez aussi l'identifiant.",
  ),
  'no-password': both('Type the password too.', 'Saisissez aussi le mot de passe.'),
  'bad-username': both(
    'The user name must be printable ASCII (64 characters at most).',
    "L'identifiant doit être en ASCII imprimable (64 caractères au plus).",
  ),
  'bad-password': both(
    'The password must be printable ASCII (128 characters at most): it travels in an HTTP header.',
    'Le mot de passe doit être en ASCII imprimable (128 caractères au plus) : il passe dans un en-tête HTTP.',
  ),
};

const FAILURES = {
  nopin: both('certificate not pinned yet', 'certificat pas encore épinglé'),
  auth: both('access refused (HTTP 403)', 'accès refusé (HTTP 403)'),
  unauth: both('credentials not taken (HTTP 401)', 'identifiants non pris (HTTP 401)'),
  credentials: both('user name or password refused', 'identifiant ou mot de passe refusé'),
  busy: both('the ATX is busy', "l'ATX est occupé"),
  rate: both('too many requests, paused', 'trop de requêtes, pause'),
  notfound: both('not found (not a PiKVM?)', 'introuvable (pas un PiKVM ?)'),
  refused: both('refused by the PiKVM', 'refusé par le PiKVM'),
  server: both('error of the PiKVM, paused', 'erreur du PiKVM, pause'),
  redirect: both('redirected (not a PiKVM?)', 'redirigé (pas un PiKVM ?)'),
  network: both('PiKVM unreachable', 'PiKVM injoignable'),
  timeout: both('no answer in time', 'pas de réponse à temps'),
  size: both('answer too large', 'réponse trop grande'),
  format: both('answer not understood (not a PiKVM?)', 'réponse non comprise (pas un PiKVM ?)'),
  aborted: both('stopped', 'arrêté'),
};

const failureWord = (err) => FAILURES[err?.kind] ?? both('error', 'erreur');

const machine = (atx) => {
  if (!atx || atx.enabled !== true) {
    return atx?.enabled === false
      ? both(
          'ATX disabled on the PiKVM (no power control, no LED)',
          'ATX désactivé sur le PiKVM (ni commande ni voyant)',
        )
      : both('machine state unknown', 'état de la machine inconnu');
  }
  if (atx.power === true) return both('machine on', 'machine allumée');
  if (atx.power === false) return both('machine off', 'machine éteinte');
  return both('machine state unknown', 'état de la machine inconnu');
};

const BUTTON_NAMES = {
  [FEATURES.POWER_ON]: both('Power on', 'Allumer'),
  [FEATURES.FORCE_OFF]: both('Force power off', "Forcer l'extinction"),
  [FEATURES.RESET]: both('Reset', 'Reset'),
};

export const T = {
  join(parts) {
    const out = {};
    for (const lang of ['en', 'fr']) {
      out[lang] = parts
        .map((p) => word(p, lang))
        .filter(Boolean)
        .join(' ')
        .slice(0, MAX_STATUS);
    }
    return out;
  },
  configUnread: (s) =>
    both(
      `Gladys did not give the configuration: tried again in ${s} s.`,
      `Gladys n'a pas donné la configuration : nouvel essai dans ${s} s.`,
    ),
  configError: (code) => CONFIG_ERRORS[code] ?? CONFIG_ERRORS.invalid,
  noPin: both(
    'The certificate of the PiKVM is not pinned yet: nothing is sent. Click "Trust the certificate" twice (or type its fingerprint).',
    "Le certificat du PiKVM n'est pas encore épinglé : rien n'est envoyé. Cliquez deux fois sur « Faire confiance au certificat » (ou saisissez son empreinte).",
  ),
  pinChanged: (fp) =>
    both(
      `The certificate of the PiKVM changed: nothing is sent, the password neither (seen: ${fp ?? '?'}). If you reinstalled the PiKVM or renewed its certificate, click "Trust the certificate" twice or type this fingerprint.`,
      `Le certificat du PiKVM a changé : rien n'est envoyé, le mot de passe non plus (vu : ${fp ?? '?'}). Si vous avez réinstallé le PiKVM ou renouvelé son certificat, cliquez deux fois sur « Faire confiance au certificat » ou saisissez cette empreinte.`,
    ),
  pinNotKept: (fp) =>
    both(
      `Certificate seen (${fp}) but /data could not keep it: type this fingerprint in the configuration.`,
      `Certificat vu (${fp}) mais /data n'a pas pu le garder : saisissez cette empreinte dans la configuration.`,
    ),
  credentialsRefused: both(
    'The PiKVM refused the user name or password (HTTP 403): nothing is tried again until you save other ones or click Test. If two-factor authentication is on, tick its box.',
    "Le PiKVM a refusé l'identifiant ou le mot de passe (HTTP 403) : rien n'est réessayé avant que vous en enregistriez d'autres ou cliquiez sur Tester. Si la double authentification est active, cochez sa case.",
  ),
  codeNeeded: both(
    'Two-factor authentication: click "Log in with a 2FA code" and type the current code (nothing is read nor sent before).',
    "Double authentification : cliquez sur « Se connecter avec un code 2FA » et saisissez le code du moment (rien n'est lu ni envoyé avant).",
  ),
  codeAgain: both(
    'The 2FA session ended (PiKVM or integration restarted, session closed): log in again with a new code.',
    'La session 2FA est terminée (PiKVM ou intégration redémarré, session fermée) : reconnectez-vous avec un nouveau code.',
  ),
  paused: (min) =>
    both(
      `The PiKVM asked to wait (429 or 5xx): reads paused for about ${min} min (Shut down still leaves).`,
      `Le PiKVM a demandé d'attendre (429 ou 5xx) : lectures en pause pour environ ${min} min (Éteindre part quand même).`,
    ),
  connecting: both('Connecting to the PiKVM...', 'Connexion au PiKVM...'),
  connected: (atx, interval) => {
    const m = machine(atx);
    return both(
      `Connected: ${m.en}; read every ${interval} s.`,
      `Connecté : ${m.fr} ; lecture toutes les ${interval} s.`,
    );
  },
  failure: (err) => {
    if (err?.kind === 'pin') return T.pinChanged(err.fingerprint);
    const what = failureWord(err);
    return both(`PiKVM: ${what.en}.`, `PiKVM : ${what.fr}.`);
  },
  stopKept: both(
    'A shutdown not taken by the PiKVM is kept: sent again while the machine reads on (3 times, 2 min at most).',
    'Un arrêt non pris par le PiKVM est gardé : renvoyé tant que la machine se lit allumée (3 fois, 2 min au plus).',
  ),
  dataUnreadable: both(
    '/data is unreadable: read again every 10 s; meanwhile nothing is learnt nor kept (pin, shutdown).',
    "/data est illisible : relu toutes les 10 s ; en attendant, rien n'est appris ni gardé (épingle, arrêt).",
  ),
  badge: {
    stopKept: both('A shutdown is kept, not taken yet', 'Un arrêt est gardé, pas encore pris'),
    atxDisabled: both('ATX disabled on the PiKVM', 'ATX désactivé sur le PiKVM'),
    unconfirmed: both('Last command not confirmed yet', 'Dernière commande pas encore confirmée'),
  },
  result: {
    shutdownSent: both(
      'Shut down: taken by the PiKVM (a short press of the power button); the operating system shuts down by itself.',
      "Éteindre : pris par le PiKVM (appui court sur le bouton d'alimentation) ; le système s'arrête de lui-même.",
    ),
    sent: (key) => {
      const name = BUTTON_NAMES[key] ?? both(key, key);
      return both(`${name.en}: taken by the PiKVM.`, `${name.fr} : pris par le PiKVM.`);
    },
    unconfirmed: both(
      'Command sent, without confirmation (no answer): never sent again by itself; reads follow.',
      "Commande envoyée, sans confirmation (pas de réponse) : jamais renvoyée d'elle-même ; des relectures suivent.",
    ),
    nothingSent: (err) => {
      const what = failureWord(err);
      return both(
        `Command not done (${what.en}): nothing sent.`,
        `Commande non faite (${what.fr}) : rien envoyé.`,
      );
    },
    alreadyOn: both(
      'Power on: the machine is already on, nothing sent.',
      'Allumer : la machine est déjà allumée, rien envoyé.',
    ),
    alreadyOff: both(
      'Force power off: the machine is already off, nothing sent.',
      "Forcer l'extinction : la machine est déjà éteinte, rien envoyé.",
    ),
    confirmedOn: both('The machine reads on.', 'La machine se lit allumée.'),
    confirmedOff: both('The machine reads off.', 'La machine se lit éteinte.'),
    stopGivenUp: both(
      'The kept shutdown was given up (2 min or 3 sends): check the machine and click again if needed.',
      "L'arrêt gardé a été abandonné (2 min ou 3 envois) : vérifiez la machine et cliquez de nouveau si besoin.",
    ),
  },
  denied: {
    unknown: both('Unknown device or feature.', 'Appareil ou fonction inconnu.'),
    readOnly: both('This feature is read only.', 'Cette fonction est en lecture seule.'),
    badValue: both('This button only takes a press.', "Ce bouton ne prend qu'un appui."),
    notConfigured: both(
      'The integration is not configured: nothing sent.',
      "L'intégration n'est pas configurée : rien envoyé.",
    ),
    noPin: both(
      'The certificate of the PiKVM is not pinned: nothing sent.',
      "Le certificat du PiKVM n'est pas épinglé : rien envoyé.",
    ),
    credentialsRefused: both(
      'The PiKVM refused the user name or password: nothing sent.',
      "Le PiKVM a refusé l'identifiant ou le mot de passe : rien envoyé.",
    ),
    codeNeeded: both(
      'Two-factor authentication: log in with a code first (configuration screen). Nothing sent.',
      "Double authentification : connectez-vous d'abord avec un code (écran de configuration). Rien envoyé.",
    ),
    unconfirmed: both(
      'Sent, without confirmation (no answer from the PiKVM): not sent again; reads follow.',
      'Envoyée, sans confirmation (pas de réponse du PiKVM) : pas renvoyée ; des relectures suivent.',
    ),
    nothingSent: (err) => {
      const what = failureWord(err);
      return both(`Not done (${what.en}): nothing sent.`, `Non fait (${what.fr}) : rien envoyé.`);
    },
    stopKept: (err) => {
      const what = failureWord(err);
      return both(
        `The PiKVM did not take the shutdown (${what.en}): kept and sent again while the machine reads on (2 min at most).`,
        `Le PiKVM n'a pas pris l'arrêt (${what.fr}) : gardé et renvoyé tant que la machine se lit allumée (2 min au plus).`,
      );
    },
    power_onOff: both(
      'Power on is off in the configuration (Allow power on): nothing sent.',
      "Allumer est désactivé dans la configuration (Autoriser l'allumage) : rien envoyé.",
    ),
    force_offOff: both(
      'Force power off is off in the configuration (Allow forced power off): nothing sent.',
      "Forcer l'extinction est désactivé dans la configuration (Autoriser l'extinction forcée) : rien envoyé.",
    ),
    resetOff: both(
      'Reset is off in the configuration (Allow reset): nothing sent.',
      'Reset est désactivé dans la configuration (Autoriser le reset) : rien envoyé.',
    ),
    paused: (s) =>
      both(
        `The PiKVM asked to wait (429 or 5xx): nothing sent, try again in ${s} s.`,
        `Le PiKVM a demandé d'attendre (429 ou 5xx) : rien envoyé, réessayez dans ${s} s.`,
      ),
    stopArrived: both(
      'A shutdown came after this command: nothing sent.',
      'Un arrêt est arrivé après cette commande : rien envoyé.',
    ),
    stopGuard: (s) =>
      both(
        `A shutdown was asked less than a minute ago: nothing sent, try again in ${s} s.`,
        `Un arrêt a été demandé il y a moins d'une minute : rien envoyé, réessayez dans ${s} s.`,
      ),
    busy: both(
      'Another command is running: nothing sent.',
      'Une autre commande est en cours : rien envoyé.',
    ),
    spacing: (s) =>
      both(
        `One command per 30 s at most: nothing sent, try again in ${s} s.`,
        `Une commande par 30 s au plus : rien envoyé, réessayez dans ${s} s.`,
      ),
    readFailed: (err) => {
      const what = failureWord(err);
      return both(
        `The ATX state could not be read (${what.en}): nothing sent.`,
        `L'état ATX n'a pas pu être lu (${what.fr}) : rien envoyé.`,
      );
    },
    atxDisabled: both(
      'ATX is disabled on the PiKVM: nothing sent.',
      "L'ATX est désactivé sur le PiKVM : rien envoyé.",
    ),
    atxBusy: both(
      'The ATX of the PiKVM is busy (another press running): nothing sent.',
      "L'ATX du PiKVM est occupé (un autre appui en cours) : rien envoyé.",
    ),
    stateUnknown: both(
      'The power LED could not be read: nothing sent.',
      "Le voyant d'alimentation n'a pas pu être lu : rien envoyé.",
    ),
    resetMachineOff: both(
      'The machine is off: Reset refused (use Power on). Nothing sent.',
      'La machine est éteinte : Reset refusé (utilisez Allumer). Rien envoyé.',
    ),
    tooLate: both(
      'The PiKVM answered too slowly: nothing sent (Gladys waits 5 s at most).',
      'Le PiKVM a répondu trop lentement : rien envoyé (Gladys attend 5 s au plus).',
    ),
  },
  test: {
    noPin: (fp) =>
      both(
        `The PiKVM shows the certificate ${fp}; it is not pinned yet, nothing else was sent. Click "Trust the certificate" twice (or type this fingerprint).`,
        `Le PiKVM montre le certificat ${fp} ; il n'est pas encore épinglé, rien d'autre n'a été envoyé. Cliquez deux fois sur « Faire confiance au certificat » (ou saisissez cette empreinte).`,
      ),
    paused: (message, s) =>
      both(
        `Not read now (pause, ${s} s left). ${word(message, 'en')}`,
        `Pas de lecture maintenant (pause, encore ${s} s). ${word(message, 'fr')}`,
      ),
    waiting: (message, s) =>
      both(
        `Read less than the refresh interval ago: next read in ${s} s. ${word(message, 'en')}`,
        `Lu il y a moins que l'intervalle de rafraîchissement : prochaine lecture dans ${s} s. ${word(message, 'fr')}`,
      ),
    ok: (atx, info) => {
      const m = machine(atx);
      const model = info?.model ? ` (${info.model})` : '';
      const temp = info?.temperature !== undefined ? info.temperature : undefined;
      return both(
        `PiKVM reached${model}: ${m.en}${temp !== undefined ? `; PiKVM at ${temp} °C` : ''}.`,
        `PiKVM joint${model} : ${m.fr}${temp !== undefined ? ` ; PiKVM à ${temp} °C` : ''}.`,
      );
    },
  },
  login: {
    notEnabled: both(
      'Tick "Two-factor authentication" in the configuration and save first.',
      "Cochez d'abord « Double authentification » dans la configuration et enregistrez.",
    ),
    badCode: both(
      'Type the 6 digits of the current code.',
      'Saisissez le code du moment (6 caractères numériques).',
    ),
    changed: both(
      'The configuration changed meanwhile: log in again.',
      'La configuration a changé entre-temps : reconnectez-vous.',
    ),
    ok: both(
      'Session opened: the PiKVM is read now. It lasts until the PiKVM or the integration restarts.',
      "Session ouverte : le PiKVM est lu maintenant. Elle dure jusqu'au redémarrage du PiKVM ou de l'intégration.",
    ),
    refused: both(
      'The PiKVM refused the password or the code (HTTP 403). Wait for the next code and try again.',
      'Le PiKVM a refusé le mot de passe ou le code (HTTP 403). Attendez le code suivant et réessayez.',
    ),
  },
  trust: {
    same: (fp) =>
      both(
        `This certificate is already the pinned one (${fp}).`,
        `Ce certificat est déjà celui épinglé (${fp}).`,
      ),
    typed: (fp) =>
      both(
        `The fingerprint typed in the configuration is the pin: replace it with ${fp} if you trust this one.`,
        `L'empreinte saisie dans la configuration est l'épingle : remplacez-la par ${fp} si vous faites confiance à celui-ci.`,
      ),
    confirm: (fp, first, address) =>
      both(
        `The PiKVM shows the certificate ${fp}. Nothing was sent. To check it, open https://${address}/ in a browser on your network and compare its SHA-256 fingerprint (certificate details). Click again within 2 minutes to trust it${first ? ' (trusted from then on: a different one later stops everything)' : ' (only if you reinstalled the PiKVM or renewed its certificate)'}.`,
        `Le PiKVM montre le certificat ${fp}. Rien n'a été envoyé. Pour le vérifier, ouvrez https://${address}/ dans un navigateur de votre réseau et comparez son empreinte SHA-256 (détails du certificat). Cliquez de nouveau dans les 2 minutes pour lui faire confiance${first ? ' (gardé ensuite : un autre plus tard arrête tout)' : ' (seulement si vous avez réinstallé le PiKVM ou renouvelé son certificat)'}.`,
      ),
    done: (fp) =>
      both(
        `Certificate ${fp} trusted: the PiKVM is read now.`,
        `Certificat ${fp} approuvé : le PiKVM est lu maintenant.`,
      ),
  },
};
