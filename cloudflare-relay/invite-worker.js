// cloudflare-relay/invite-worker.js
// Ghostr Invite Worker — Universal Links / App Links + Landing
//
// SÉCURITÉ — INVARIANTS À NE JAMAIS CASSER :
//   1. Le secret de l'invitation est UNIQUEMENT dans le fragment URL (#…),
//      jamais dans le path ni le query. Les fragments ne sont JAMAIS envoyés
//      au serveur HTTP → aucune fuite côté Cloudflare/CDN/logs/Referer.
//   2. La landing /i ne charge AUCUNE ressource externe (pas de fonts CDN,
//      pas d'analytics, pas d'images distantes). CSP stricte enforcée.
//   3. Aucun fingerprinting serveur de plateforme : la détection iOS/Android
//      est faite UNIQUEMENT côté client via navigator.userAgent.
//   4. history.replaceState() efface le fragment de l'historique navigateur
//      dès que la page le lit.
//   5. Cache-Control: no-store partout (pas de cache intermédiaire).
//
// LOGO :
//   La constante LOGO_BASE64 contient le PNG du logo encodé en base64.
//   Pour la régénérer : voir embed-logo.sh dans ce même dossier.

const LOGO_BASE64 = "__LOGO_BASE64__";

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'interest-cohort=(), browsing-topics=(), geolocation=(), camera=(), microphone=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'CDN-Cache-Control': 'no-store',
  'Cloudflare-CDN-Cache-Control': 'no-store',
};

const HTML_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "connect-src 'none'",
  "manifest-src 'none'",
].join('; ');

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method !== 'GET' && method !== 'HEAD') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { ...SECURITY_HEADERS, 'Allow': 'GET, HEAD' },
      });
    }

    if (pathname === '/.well-known/apple-app-site-association' || pathname === '/apple-app-site-association') {
      const aasa = {
        applinks: {
          details: [{
            appIDs: [`${env.TEAM_ID}.${env.APP_BUNDLE}`],
            components: [
              { '/': '/i', comment: 'Ghostr invitation links' },
              { '/': '/i/', comment: 'Ghostr invitation links (trailing slash)' },
            ],
          }],
        },
      };
      return new Response(JSON.stringify(aasa), {
        status: 200,
        headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    if (pathname === '/.well-known/assetlinks.json') {
      const fingerprints = [];
      if (env.SHA256_UPLOAD) fingerprints.push(env.SHA256_UPLOAD);
      if (env.SHA256_PLAY && env.SHA256_PLAY !== env.SHA256_UPLOAD) {
        fingerprints.push(env.SHA256_PLAY);
      }
      const assetlinks = [{
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: env.ANDROID_PACKAGE,
          sha256_cert_fingerprints: fingerprints,
        },
      }];
      return new Response(JSON.stringify(assetlinks), {
        status: 200,
        headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    if (pathname === '/i' || pathname === '/i/') {
      return new Response(buildLandingHtml(env), {
        status: 200,
        headers: {
          ...SECURITY_HEADERS,
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': HTML_CSP,
        },
      });
    }

    return new Response('Not Found', {
      status: 404,
      headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },
};

function buildLandingHtml(env) {
  const iosAppId = env.IOS_APP_ID || '0';
  const androidPackage = env.ANDROID_PACKAGE || 'com.ghostr.app';
  const appStoreUrl = iosAppId !== '0'
    ? `https://apps.apple.com/app/id${iosAppId}`
    : 'https://apps.apple.com/';
  const playStoreUrl = `https://play.google.com/store/apps/details?id=${androidPackage}`;

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#0A0F14">
<meta name="color-scheme" content="dark">
<title>Ghostr</title>
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#0A0F14;
  --surface:#0F161C;
  --surface-2:#1A252F;
  --primary:#00D9A6;
  --primary-glow:rgba(0,217,166,.45);
  --primary-soft:rgba(0,217,166,.12);
  --text:#F0F4F8;
  --text-muted:#8BA4B8;
  --text-dim:#5D7485;
  --border:rgba(139,164,184,.08);
}
html,body{
  min-height:100dvh;
  background:var(--bg);
  color:var(--text);
  font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,system-ui,sans-serif;
  font-size:16px;
  line-height:1.5;
  letter-spacing:-0.01em;
  text-rendering:optimizeLegibility;
  -webkit-font-smoothing:antialiased;
  -moz-osx-font-smoothing:grayscale;
}
body{
  display:flex;
  align-items:center;
  justify-content:center;
  padding:24px;
  position:relative;
  overflow:hidden;
}
body::before{
  content:"";
  position:fixed;
  inset:-50%;
  background:radial-gradient(circle at 50% 30%, rgba(0,217,166,.06) 0%, transparent 50%);
  pointer-events:none;
  z-index:0;
}
.card{
  position:relative;
  z-index:1;
  max-width:400px;
  width:100%;
  text-align:center;
  animation:fadeUp 600ms cubic-bezier(.2,.8,.2,1) both;
}
@keyframes fadeUp{
  from{opacity:0;transform:translateY(12px)}
  to{opacity:1;transform:none}
}
.logo-wrap{
  position:relative;
  width:160px;
  height:160px;
  margin:0 auto 32px;
  display:flex;
  align-items:center;
  justify-content:center;
}
.ring{
  position:absolute;
  border:1px solid var(--primary);
  border-radius:50%;
  opacity:0;
  animation:ringPulse 4s cubic-bezier(.4,0,.6,1) infinite;
}
.ring-1{width:160px;height:160px;animation-delay:0s;border-color:rgba(0,217,166,.5)}
.ring-2{width:200px;height:200px;animation-delay:.6s;border-color:rgba(0,217,166,.3)}
.ring-3{width:240px;height:240px;animation-delay:1.2s;border-color:rgba(0,217,166,.18)}
@keyframes ringPulse{
  0%{opacity:0;transform:scale(.85)}
  20%{opacity:1}
  100%{opacity:0;transform:scale(1.15)}
}
.logo{
  position:relative;
  width:120px;
  height:120px;
  display:block;
  filter:drop-shadow(0 0 24px var(--primary-glow));
  animation:breath 3.5s cubic-bezier(.4,0,.6,1) infinite;
}
@keyframes breath{
  0%,100%{transform:scale(1)}
  50%{transform:scale(1.04)}
}
h1{
  font-size:26px;
  font-weight:700;
  letter-spacing:-0.02em;
  margin-bottom:10px;
  color:var(--text);
}
.subtitle{
  color:var(--text-muted);
  margin-bottom:36px;
  font-size:15px;
  max-width:320px;
  margin-left:auto;
  margin-right:auto;
}
.btn{
  display:flex;
  align-items:center;
  justify-content:center;
  width:100%;
  height:52px;
  padding:0 24px;
  border-radius:14px;
  font-size:16px;
  font-weight:600;
  font-family:inherit;
  letter-spacing:-0.01em;
  text-decoration:none;
  margin-bottom:12px;
  border:1px solid transparent;
  cursor:pointer;
  transition:transform .15s ease, box-shadow .25s ease, background .15s ease;
  position:relative;
  overflow:hidden;
}
.btn:active{transform:scale(.98)}
.btn-primary{
  background:var(--primary);
  color:#0A0F14;
  box-shadow:0 0 0 0 var(--primary-glow), 0 8px 24px -8px rgba(0,217,166,.4);
}
.btn-primary:hover{
  box-shadow:0 0 32px 0 var(--primary-glow), 0 12px 32px -8px rgba(0,217,166,.5);
}
.btn-secondary{
  background:transparent;
  color:var(--text);
  border-color:var(--border);
}
.btn-secondary:hover{
  background:var(--surface-2);
  border-color:rgba(139,164,184,.16);
}
.hidden{display:none !important}
section{display:flex;flex-direction:column;align-items:center}
.loader-text{
  color:var(--text-muted);
  font-size:13px;
  letter-spacing:0.06em;
  text-transform:uppercase;
  margin-top:6px;
  font-weight:500;
}
.icon-warning{
  width:120px;
  height:120px;
  display:flex;
  align-items:center;
  justify-content:center;
  margin:0 auto 32px;
  border-radius:50%;
  background:var(--surface);
  border:1px solid var(--border);
  position:relative;
}
.icon-warning::before{
  content:"";
  position:absolute;
  inset:-1px;
  border-radius:50%;
  background:linear-gradient(135deg, rgba(255,181,71,.3), transparent);
  z-index:-1;
}
.icon-warning svg{
  width:48px;
  height:48px;
  color:#FFB547;
}
.footer{
  margin-top:32px;
  padding-top:20px;
  border-top:1px solid var(--border);
  font-size:13px;
  color:var(--text-dim);
  display:flex;
  align-items:center;
  justify-content:center;
  gap:6px;
}
.footer svg{width:14px;height:14px;flex-shrink:0}
@media (prefers-reduced-motion: reduce){
  .ring,.logo,.card{animation:none}
}
[dir="rtl"] .footer{direction:rtl}
</style>
</head>
<body>
<main class="card">

  <section id="state-opening">
    <div class="logo-wrap">
      <div class="ring ring-3"></div>
      <div class="ring ring-2"></div>
      <div class="ring ring-1"></div>
      <img class="logo" src="data:image/png;base64,${LOGO_BASE64}" alt="Ghostr">
    </div>
    <h1 data-i18n="opening">Opening Ghostr…</h1>
    <p class="loader-text" data-i18n="connecting">Establishing secure connection</p>
  </section>

  <section id="state-fallback" class="hidden">
    <div class="logo-wrap">
      <div class="ring ring-3"></div>
      <div class="ring ring-2"></div>
      <div class="ring ring-1"></div>
      <img class="logo" src="data:image/png;base64,${LOGO_BASE64}" alt="Ghostr">
    </div>
    <h1 data-i18n="join_title">Join the conversation</h1>
    <p class="subtitle" data-i18n="join_subtitle">Download Ghostr to accept this end-to-end encrypted invitation.</p>
    <a id="btn-store" class="btn btn-primary" href="#" rel="noreferrer noopener" data-i18n="install">Install Ghostr</a>
    <button id="btn-retry" class="btn btn-secondary" type="button" data-i18n="have_app">I already have the app</button>
    <div class="footer">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      <span data-i18n="e2e_notice">End-to-end encrypted · Code never leaves your device</span>
    </div>
  </section>

  <section id="state-invalid" class="hidden">
    <div class="icon-warning">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
    </div>
    <h1 data-i18n="invalid_title">Invalid link</h1>
    <p class="subtitle" data-i18n="invalid_subtitle">This invitation link is incomplete or has been corrupted. Ask your contact for a new one.</p>
    <a id="btn-store-fallback" class="btn btn-primary" href="#" rel="noreferrer noopener" data-i18n="install">Install Ghostr</a>
  </section>

  <noscript>
    <div class="logo-wrap"><img class="logo" src="data:image/png;base64,${LOGO_BASE64}" alt="Ghostr"></div>
    <h1>Ghostr</h1>
    <p class="subtitle">Enable JavaScript to open this invitation, or download the app.</p>
    <a class="btn btn-primary" href="${appStoreUrl}" rel="noreferrer noopener">App Store</a>
    <a class="btn btn-primary" href="${playStoreUrl}" rel="noreferrer noopener">Google Play</a>
  </noscript>

</main>

<script>
(function(){
  'use strict';

  // ═══════════════════════════════════════════════════════════════════
  // I18N — Détection langue navigateur, traductions inline (zéro IO)
  // ═══════════════════════════════════════════════════════════════════
  var DICT = {
    en: {
      opening: "Opening Ghostr\u2026",
      connecting: "Establishing secure connection",
      join_title: "Join the conversation",
      join_subtitle: "Download Ghostr to accept this end-to-end encrypted invitation.",
      install: "Install Ghostr",
      have_app: "I already have the app",
      e2e_notice: "End-to-end encrypted \u00B7 Code never leaves your device",
      invalid_title: "Invalid link",
      invalid_subtitle: "This invitation link is incomplete or has been corrupted. Ask your contact for a new one."
    },
    fr: {
      opening: "Ouverture de Ghostr\u2026",
      connecting: "\u00C9tablissement de la connexion s\u00E9curis\u00E9e",
      join_title: "Rejoindre la conversation",
      join_subtitle: "T\u00E9l\u00E9chargez Ghostr pour accepter cette invitation chiffr\u00E9e de bout en bout.",
      install: "Installer Ghostr",
      have_app: "J'ai d\u00E9j\u00E0 l'application",
      e2e_notice: "Chiffr\u00E9 de bout en bout \u00B7 Le code reste sur votre appareil",
      invalid_title: "Lien invalide",
      invalid_subtitle: "Ce lien d'invitation est incomplet ou a \u00E9t\u00E9 corrompu. Demandez un nouveau lien \u00E0 votre contact."
    },
    es: {
      opening: "Abriendo Ghostr\u2026",
      connecting: "Estableciendo conexi\u00F3n segura",
      join_title: "\u00DAnete a la conversaci\u00F3n",
      join_subtitle: "Descarga Ghostr para aceptar esta invitaci\u00F3n cifrada de extremo a extremo.",
      install: "Instalar Ghostr",
      have_app: "Ya tengo la aplicaci\u00F3n",
      e2e_notice: "Cifrado de extremo a extremo \u00B7 El c\u00F3digo nunca sale de tu dispositivo",
      invalid_title: "Enlace no v\u00E1lido",
      invalid_subtitle: "Este enlace de invitaci\u00F3n est\u00E1 incompleto o ha sido alterado. Pide a tu contacto uno nuevo."
    },
    de: {
      opening: "Ghostr wird ge\u00F6ffnet\u2026",
      connecting: "Sichere Verbindung wird aufgebaut",
      join_title: "Unterhaltung beitreten",
      join_subtitle: "Lade Ghostr herunter, um diese Ende-zu-Ende-verschl\u00FCsselte Einladung anzunehmen.",
      install: "Ghostr installieren",
      have_app: "Ich habe die App bereits",
      e2e_notice: "Ende-zu-Ende-verschl\u00FCsselt \u00B7 Code verl\u00E4sst dein Ger\u00E4t nicht",
      invalid_title: "Ung\u00FCltiger Link",
      invalid_subtitle: "Dieser Einladungslink ist unvollst\u00E4ndig oder besch\u00E4digt. Bitte deinen Kontakt um einen neuen."
    },
    it: {
      opening: "Apertura di Ghostr\u2026",
      connecting: "Connessione sicura in corso",
      join_title: "Unisciti alla conversazione",
      join_subtitle: "Scarica Ghostr per accettare questo invito crittografato end-to-end.",
      install: "Installa Ghostr",
      have_app: "Ho gi\u00E0 l'app",
      e2e_notice: "Crittografia end-to-end \u00B7 Il codice resta sul tuo dispositivo",
      invalid_title: "Link non valido",
      invalid_subtitle: "Questo link di invito \u00E8 incompleto o \u00E8 stato danneggiato. Chiedi al tuo contatto un nuovo link."
    },
    pt: {
      opening: "Abrindo Ghostr\u2026",
      connecting: "Estabelecendo conex\u00E3o segura",
      join_title: "Entre na conversa",
      join_subtitle: "Baixe o Ghostr para aceitar este convite criptografado de ponta a ponta.",
      install: "Instalar Ghostr",
      have_app: "J\u00E1 tenho o app",
      e2e_notice: "Criptografia ponta a ponta \u00B7 O c\u00F3digo nunca sai do seu dispositivo",
      invalid_title: "Link inv\u00E1lido",
      invalid_subtitle: "Este link de convite est\u00E1 incompleto ou foi corrompido. Pe\u00E7a um novo ao seu contato."
    },
    nl: {
      opening: "Ghostr openen\u2026",
      connecting: "Beveiligde verbinding tot stand brengen",
      join_title: "Deelnemen aan het gesprek",
      join_subtitle: "Download Ghostr om deze end-to-end versleutelde uitnodiging te accepteren.",
      install: "Ghostr installeren",
      have_app: "Ik heb de app al",
      e2e_notice: "End-to-end versleuteld \u00B7 De code verlaat je apparaat niet",
      invalid_title: "Ongeldige link",
      invalid_subtitle: "Deze uitnodigingslink is onvolledig of beschadigd. Vraag je contact om een nieuwe."
    },
    ru: {
      opening: "\u041E\u0442\u043A\u0440\u044B\u0442\u0438\u0435 Ghostr\u2026",
      connecting: "\u0423\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0430 \u0437\u0430\u0449\u0438\u0449\u0451\u043D\u043D\u043E\u0433\u043E \u0441\u043E\u0435\u0434\u0438\u043D\u0435\u043D\u0438\u044F",
      join_title: "\u041F\u0440\u0438\u0441\u043E\u0435\u0434\u0438\u043D\u0438\u0442\u044C\u0441\u044F \u043A \u0431\u0435\u0441\u0435\u0434\u0435",
      join_subtitle: "\u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u0435 Ghostr, \u0447\u0442\u043E\u0431\u044B \u043F\u0440\u0438\u043D\u044F\u0442\u044C \u044D\u0442\u043E \u0441\u043A\u0432\u043E\u0437\u043D\u043E\u0435 \u0437\u0430\u0448\u0438\u0444\u0440\u043E\u0432\u0430\u043D\u043D\u043E\u0435 \u043F\u0440\u0438\u0433\u043B\u0430\u0448\u0435\u043D\u0438\u0435.",
      install: "\u0423\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u044C Ghostr",
      have_app: "\u0423 \u043C\u0435\u043D\u044F \u0443\u0436\u0435 \u0435\u0441\u0442\u044C \u043F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u0435",
      e2e_notice: "\u0421\u043A\u0432\u043E\u0437\u043D\u043E\u0435 \u0448\u0438\u0444\u0440\u043E\u0432\u0430\u043D\u0438\u0435 \u00B7 \u041A\u043E\u0434 \u043D\u0435 \u043F\u043E\u043A\u0438\u0434\u0430\u0435\u0442 \u0432\u0430\u0448\u0435 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u043E",
      invalid_title: "\u041D\u0435\u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0442\u0435\u043B\u044C\u043D\u0430\u044F \u0441\u0441\u044B\u043B\u043A\u0430",
      invalid_subtitle: "\u042D\u0442\u0430 \u0441\u0441\u044B\u043B\u043A\u0430-\u043F\u0440\u0438\u0433\u043B\u0430\u0448\u0435\u043D\u0438\u0435 \u043F\u043E\u0432\u0440\u0435\u0436\u0434\u0435\u043D\u0430 \u0438\u043B\u0438 \u043D\u0435\u043F\u043E\u043B\u043D\u0430. \u041F\u043E\u043F\u0440\u043E\u0441\u0438\u0442\u0435 \u043A\u043E\u043D\u0442\u0430\u043A\u0442 \u043F\u0440\u0438\u0441\u043B\u0430\u0442\u044C \u043D\u043E\u0432\u0443\u044E."
    },
    ar: {
      opening: "\u062C\u0627\u0631\u064D \u0641\u062A\u062D Ghostr\u2026",
      connecting: "\u0625\u0646\u0634\u0627\u0621 \u0627\u062A\u0635\u0627\u0644 \u0622\u0645\u0646",
      join_title: "\u0627\u0646\u0636\u0645 \u0625\u0644\u0649 \u0627\u0644\u0645\u062D\u0627\u062F\u062B\u0629",
      join_subtitle: "\u0646\u0632\u0651\u0644 Ghostr \u0644\u0642\u0628\u0648\u0644 \u0647\u0630\u0647 \u0627\u0644\u062F\u0639\u0648\u0629 \u0627\u0644\u0645\u0634\u0641\u0651\u0631\u0629 \u0645\u0646 \u0637\u0631\u0641 \u0625\u0644\u0649 \u0637\u0631\u0641.",
      install: "\u062A\u062B\u0628\u064A\u062A Ghostr",
      have_app: "\u0644\u062F\u064A \u0627\u0644\u062A\u0637\u0628\u064A\u0642 \u0628\u0627\u0644\u0641\u0639\u0644",
      e2e_notice: "\u062A\u0634\u0641\u064A\u0631 \u0645\u0646 \u0637\u0631\u0641 \u0625\u0644\u0649 \u0637\u0631\u0641 \u00B7 \u0627\u0644\u0631\u0645\u0632 \u0644\u0627 \u064A\u063A\u0627\u062F\u0631 \u062C\u0647\u0627\u0632\u0643",
      invalid_title: "\u0631\u0627\u0628\u0637 \u063A\u064A\u0631 \u0635\u0627\u0644\u062D",
      invalid_subtitle: "\u0631\u0627\u0628\u0637 \u0627\u0644\u062F\u0639\u0648\u0629 \u063A\u064A\u0631 \u0645\u0643\u062A\u0645\u0644 \u0623\u0648 \u062A\u0627\u0644\u0641. \u0627\u0637\u0644\u0628 \u0645\u0646 \u062C\u0647\u0629 \u0627\u062A\u0635\u0627\u0644\u0643 \u0631\u0627\u0628\u0637\u064B\u0627 \u062C\u062F\u064A\u062F\u064B\u0627."
    },
    ja: {
      opening: "Ghostr \u3092\u958B\u3044\u3066\u3044\u307E\u3059\u2026",
      connecting: "\u5B89\u5168\u306A\u63A5\u7D9A\u3092\u78BA\u7ACB\u4E2D",
      join_title: "\u4F1A\u8A71\u306B\u53C2\u52A0",
      join_subtitle: "Ghostr \u3092\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9\u3057\u3066\u3001\u30A8\u30F3\u30C9\u30C4\u30FC\u30A8\u30F3\u30C9\u6697\u53F7\u5316\u3055\u308C\u305F\u62DB\u5F85\u3092\u53D7\u3051\u5165\u308C\u3066\u304F\u3060\u3055\u3044\u3002",
      install: "Ghostr \u3092\u30A4\u30F3\u30B9\u30C8\u30FC\u30EB",
      have_app: "\u30A2\u30D7\u30EA\u306F\u65E2\u306B\u3042\u308A\u307E\u3059",
      e2e_notice: "\u30A8\u30F3\u30C9\u30C4\u30FC\u30A8\u30F3\u30C9\u6697\u53F7\u5316 \u00B7 \u30B3\u30FC\u30C9\u306F\u7AEF\u672B\u304B\u3089\u51FA\u307E\u305B\u3093",
      invalid_title: "\u7121\u52B9\u306A\u30EA\u30F3\u30AF",
      invalid_subtitle: "\u3053\u306E\u62DB\u5F85\u30EA\u30F3\u30AF\u306F\u4E0D\u5B8C\u5168\u307E\u305F\u306F\u7834\u640D\u3057\u3066\u3044\u307E\u3059\u3002\u9023\u7D61\u5148\u306B\u65B0\u3057\u3044\u30EA\u30F3\u30AF\u3092\u4F9D\u983C\u3057\u3066\u304F\u3060\u3055\u3044\u3002"
    },
    zh: {
      opening: "\u6B63\u5728\u6253\u5F00 Ghostr\u2026",
      connecting: "\u5EFA\u7ACB\u5B89\u5168\u8FDE\u63A5",
      join_title: "\u52A0\u5165\u5BF9\u8BDD",
      join_subtitle: "\u4E0B\u8F7D Ghostr \u4EE5\u63A5\u53D7\u6B64\u7AEF\u5230\u7AEF\u52A0\u5BC6\u9080\u8BF7\u3002",
      install: "\u5B89\u88C5 Ghostr",
      have_app: "\u6211\u5DF2\u5B89\u88C5\u5E94\u7528",
      e2e_notice: "\u7AEF\u5230\u7AEF\u52A0\u5BC6 \u00B7 \u4EE3\u7801\u7EDD\u4E0D\u79BB\u5F00\u60A8\u7684\u8BBE\u5907",
      invalid_title: "\u65E0\u6548\u94FE\u63A5",
      invalid_subtitle: "\u6B64\u9080\u8BF7\u94FE\u63A5\u4E0D\u5B8C\u6574\u6216\u5DF2\u635F\u574F\u3002\u8BF7\u5411\u60A8\u7684\u8054\u7CFB\u4EBA\u7D22\u53D6\u65B0\u94FE\u63A5\u3002"
    },
    ko: {
      opening: "Ghostr \uC5EC\uB294 \uC911\u2026",
      connecting: "\uBCF4\uC548 \uC5F0\uACB0 \uC124\uC815 \uC911",
      join_title: "\uB300\uD654\uC5D0 \uCC38\uC5EC",
      join_subtitle: "Ghostr\uB97C \uB2E4\uC6B4\uB85C\uB4DC\uD558\uC5EC \uC885\uB2E8 \uAC04 \uC554\uD638\uD654\uB41C \uCD08\uB300\uB97C \uC218\uB77D\uD558\uC138\uC694.",
      install: "Ghostr \uC124\uCE58",
      have_app: "\uC774\uBBF8 \uC571\uC774 \uC788\uC2B5\uB2C8\uB2E4",
      e2e_notice: "\uC885\uB2E8 \uAC04 \uC554\uD638\uD654 \u00B7 \uCF54\uB4DC\uB294 \uAE30\uAE30\uB97C \uB5A0\uB098\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4",
      invalid_title: "\uC798\uBABB\uB41C \uB9C1\uD06C",
      invalid_subtitle: "\uC774 \uCD08\uB300 \uB9C1\uD06C\uB294 \uBD88\uC644\uC804\uD558\uAC70\uB098 \uC190\uC0C1\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uC5F0\uB77D\uCC98\uC5D0 \uC0C8 \uB9C1\uD06C\uB97C \uC694\uCCAD\uD558\uC138\uC694."
    }
  };

  var RTL_LANGS = ['ar', 'he', 'fa', 'ur'];

  function detectLang(){
    var langs = navigator.languages || [navigator.language || 'en'];
    for (var i = 0; i < langs.length; i++) {
      var code = (langs[i] || '').slice(0, 2).toLowerCase();
      if (DICT[code]) return code;
    }
    return 'en';
  }

  function applyI18n(){
    var lang = detectLang();
    var t = DICT[lang];
    document.documentElement.lang = lang;
    if (RTL_LANGS.indexOf(lang) !== -1) {
      document.documentElement.dir = 'rtl';
    }
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute('data-i18n');
      if (t[key]) nodes[i].textContent = t[key];
    }
  }
  applyI18n();

  // ═══════════════════════════════════════════════════════════════════
  // ÉTAPE 1 : Capturer le fragment AVANT TOUT, puis l'effacer
  // ═══════════════════════════════════════════════════════════════════
  var fragment = '';
  try {
    var raw = window.location.hash || '';
    if (raw.length > 1) {
      fragment = raw.slice(1);
      try {
        window.history.replaceState(null, '', window.location.pathname);
      } catch (e) { /* iOS WebView 9- : ignorer */ }
    }
  } catch (e) {
    fragment = '';
  }

  // ═══════════════════════════════════════════════════════════════════
  // ÉTAPE 2 : Détecter la plateforme (CLIENT-SIDE UNIQUEMENT)
  // ═══════════════════════════════════════════════════════════════════
  var ua = navigator.userAgent || '';
  var isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  var isAndroid = /Android/.test(ua);
  var storeUrl = isIOS ? ${JSON.stringify(appStoreUrl)} :
                 isAndroid ? ${JSON.stringify(playStoreUrl)} :
                 ${JSON.stringify(appStoreUrl)};

  var storeBtn = document.getElementById('btn-store');
  var storeBtnFb = document.getElementById('btn-store-fallback');
  if (storeBtn) storeBtn.href = storeUrl;
  if (storeBtnFb) storeBtnFb.href = storeUrl;

  // ═══════════════════════════════════════════════════════════════════
  // ÉTAPE 3 : Si pas de fragment, lien invalide
  // ═══════════════════════════════════════════════════════════════════
  if (!fragment) {
    show('state-invalid');
    return;
  }

  // ═══════════════════════════════════════════════════════════════════
  // ÉTAPE 4 : Tenter l'ouverture du scheme deep link
  // ═══════════════════════════════════════════════════════════════════
  // Stratégies par plateforme :
  //   • iOS (Safari)        : ghostr://invite#<fragment>
  //                           Safari ouvre l'app si elle est installée et a déclaré
  //                           le scheme. Sinon, ne fait rien (silencieux).
  //   • Android (Chrome 25+) : intent://invite/<fragment>#Intent;...;end
  //                           Chrome bloque les custom schemes lancés via JS sans
  //                           vérification, mais traite intent:// comme natif.
  //                           Si l'app n'est pas installée, S.browser_fallback_url
  //                           prend le relais et redirige vers le Play Store.
  //   • Desktop / autres    : ghostr://invite#<fragment> (best-effort)
  //
  // L'app reçoit une URL de la forme :
  //   • iOS / Android scheme  : ghostr://invite#<fragment>
  //   • Android intent path   : ghostr://invite/<fragment>
  // parseInviteString gère les deux formats.
  // ═══════════════════════════════════════════════════════════════════
  var ANDROID_PACKAGE = ${JSON.stringify(androidPackage)};
  var schemeUrlIOS = 'ghostr://invite#' + fragment;
  // Pour intent://, le fragment va dans le path (re-encodé pour respecter RFC 3986)
  var androidIntentUrl =
    'intent://invite/' + encodeURIComponent(fragment) +
    '#Intent;scheme=ghostr;package=' + ANDROID_PACKAGE +
    ';S.browser_fallback_url=' + encodeURIComponent(storeUrl) +
    ';end';

  var fellBack = false;
  var startedAt = Date.now();
  var retryBtn = document.getElementById('btn-retry');
  var retryOriginalText = retryBtn ? retryBtn.textContent : '';

  function tryOpenApp() {
    try {
      if (isAndroid) {
        // intent:// gère lui-même le fallback Play Store si app non installée
        window.location.href = androidIntentUrl;
      } else {
        // iOS / Desktop : direct scheme
        window.location.href = schemeUrlIOS;
      }
    } catch (e) { /* silent */ }
  }

  function showFallback() {
    if (fellBack) return;
    fellBack = true;
    show('state-fallback');
  }

  // Tentative immédiate (au chargement)
  tryOpenApp();

  // Si après 1.5s on est toujours visible → l'app n'a pas pris la main
  setTimeout(function() {
    if (document.visibilityState === 'visible' && Date.now() - startedAt > 1400) {
      showFallback();
    }
  }, 1500);

  // Bouton "J'ai déjà l'application"
  if (retryBtn) {
    retryBtn.addEventListener('click', function() {
      // Visual feedback : griser le bouton pendant la tentative
      retryBtn.style.opacity = '0.5';
      retryBtn.style.pointerEvents = 'none';
      var clickedAt = Date.now();

      tryOpenApp();

      // Si après 2s la page est toujours visible, l'app n'a pas répondu :
      // restaurer le bouton et highlight le bouton "Installer" pour guider l'user
      setTimeout(function() {
        if (document.visibilityState === 'visible' && Date.now() - clickedAt >= 1900) {
          retryBtn.style.opacity = '';
          retryBtn.style.pointerEvents = '';
          var installBtn = document.getElementById('btn-store');
          if (installBtn) {
            installBtn.style.boxShadow = '0 0 32px var(--primary-glow), 0 12px 32px -8px rgba(0,217,166,.5)';
            installBtn.style.transform = 'scale(1.02)';
            try { installBtn.scrollIntoView({behavior: 'smooth', block: 'center'}); } catch (e) {}
            setTimeout(function() {
              installBtn.style.boxShadow = '';
              installBtn.style.transform = '';
            }, 2400);
          }
        }
      }, 2000);
    });
  }

  // Si la page redevient visible (ex: l'app n'a pas pris le relais et l'utilisateur
  // est revenu au navigateur), s'assurer qu'on est en fallback
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible' && Date.now() - startedAt > 1400) {
      showFallback();
      // Restaurer le bouton si il était désactivé
      if (retryBtn) {
        retryBtn.style.opacity = '';
        retryBtn.style.pointerEvents = '';
      }
    }
  });

  function show(id) {
    var sections = ['state-opening', 'state-fallback', 'state-invalid'];
    for (var i = 0; i < sections.length; i++) {
      var el = document.getElementById(sections[i]);
      if (!el) continue;
      if (sections[i] === id) el.classList.remove('hidden');
      else el.classList.add('hidden');
    }
  }
})();
</script>
</body>
</html>`;
}