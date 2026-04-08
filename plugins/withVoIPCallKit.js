// plugins/withVoIPCallKit.js
//
// Expo config plugin — PushKit + CallKit native integration for iOS
//
// CE PLUGIN FAIT:
//   1. Ajoute 'voip' à UIBackgroundModes (Info.plist)
//   2. Patche le bridging header pour importer RNCallKeep + RNVoipPushNotificationManager
//   3. Patche AppDelegate.swift pour:
//      a. Enregistrer PushKit au lancement
//      b. Setup CallKit avec includesCallsInRecents: false (privacy)
//      c. Handler VoIP push → reportNewIncomingCall IMMÉDIATEMENT (exigence Apple iOS 13+)
//
// POURQUOI C'EST NATIF:
//   Apple exige que CallKit reportNewIncomingCall soit appelé IMMÉDIATEMENT
//   quand un VoIP push arrive — AVANT que le JS bridge soit prêt.
//   Si l'app ne le fait pas, iOS la TERMINE. C'est pourquoi Signal et WhatsApp
//   font cette partie en natif dans l'AppDelegate.
//
// SÉCURITÉ:
//   - Le payload VoIP push ne contient AUCUNE donnée identifiable
//   - Le nom affiché est "Appel vocal chiffré…" (100% générique)
//   - Le vrai nom apparaît APRÈS déchiffrement E2E (via updateDisplay en JS)
//   - includesCallsInRecents: false → pas de fuite vers l'historique iOS / iCloud
//   - Le token VoIP est chiffré au repos comme le token APNs classique

const { withDangerousMod, withInfoPlist } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

function withVoIPCallKit(config) {
  // ═══════════════════════════════════════
  // 1. Info.plist: UIBackgroundModes += voip
  // ═══════════════════════════════════════
  config = withInfoPlist(config, (config) => {
    const bgModes = config.modResults.UIBackgroundModes || [];
    if (!bgModes.includes('voip')) {
      bgModes.push('voip');
      console.log('[withVoIPCallKit] iOS: added "voip" to UIBackgroundModes');
    }
    config.modResults.UIBackgroundModes = bgModes;
    return config;
  });

  // ═══════════════════════════════════════
  // 2. Native: Bridging Header + AppDelegate
  // ═══════════════════════════════════════
  config = withDangerousMod(config, ['ios', async (config) => {
    const iosPath = config.modRequest.platformProjectRoot;

    // Trouver le répertoire de l'app iOS
    const appName = findAppDirName(iosPath);
    if (!appName) {
      console.warn('[withVoIPCallKit] ⚠️ Could not find iOS app directory');
      return config;
    }

    const appDir = path.join(iosPath, appName);

    // 2a. Bridging Header
    patchBridgingHeader(appDir, appName);

    // 2b. AppDelegate.swift
    const swiftPath = path.join(appDir, 'AppDelegate.swift');
    if (fs.existsSync(swiftPath)) {
      patchAppDelegateSwift(swiftPath);
    } else {
      // 2c. Fallback: AppDelegate.mm (Objective-C++)
      const mmPath = path.join(appDir, 'AppDelegate.mm');
      if (fs.existsSync(mmPath)) {
        patchAppDelegateObjCpp(mmPath);
      } else {
        console.warn('[withVoIPCallKit] ⚠️ No AppDelegate found (.swift or .mm)');
      }
    }

    // 2d. Copier l'icône CallKit dans le bundle iOS
    // CXProviderConfiguration.iconTemplateImageData utilise UIImage(named:)
    // qui cherche dans le bundle principal. L'icône doit être un PNG
    // monochrome (40×40pt / 80×80px @2x) — iOS applique sa propre teinte.
    // On utilise icon_nobg.png (logo sans fond) comme source.
    copyCallKitIcon(iosPath, appDir);

    return config;
  }]);

  return config;
}

// ═══════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════

/** Trouve le nom du répertoire contenant AppDelegate dans ios/ */
function findAppDirName(iosPath) {
  if (!fs.existsSync(iosPath)) return null;
  const entries = fs.readdirSync(iosPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'Pods' || entry.name === 'build' || entry.name.endsWith('.xcodeproj') || entry.name.endsWith('.xcworkspace')) continue;
    const candidate = path.join(iosPath, entry.name, 'AppDelegate.swift');
    const candidateMm = path.join(iosPath, entry.name, 'AppDelegate.mm');
    if (fs.existsSync(candidate) || fs.existsSync(candidateMm)) {
      return entry.name;
    }
  }
  return null;
}

// ═══════════════════════════════════════════════
// CallKit Icon (monochrome template pour l'écran d'appel)
// ═══════════════════════════════════════════════

const CALLKIT_ICON_NAME = 'GhostrCallIcon.png';

/**
 * Copie l'icône Ghostr dans le bundle iOS pour CallKit.
 * 
 * CXProviderConfiguration.iconTemplateImageData affiche un petit
 * icône monochrome sur l'écran d'appel natif iOS (à côté du nom).
 * L'icône doit être un PNG 40×40pt (80×80px @2x) monochrome.
 * iOS applique automatiquement la teinte (blanc sur fond foncé).
 * 
 * On utilise assets/icon_nobg.png (logo Ghostr sans fond) comme
 * source. iOS le redimensionne et le rend en template automatiquement.
 */
function copyCallKitIcon(iosPath, appDir) {
  const iconSource = path.resolve(__dirname, '..', 'assets', 'icon_nobg.png');
  if (!fs.existsSync(iconSource)) {
    console.warn('[withVoIPCallKit] ⚠️ icon_nobg.png not found — CallKit icon skipped');
    return;
  }

  // Copier dans le répertoire iOS racine (pas le sous-dossier app)
  // Le pbxproj référence le fichier avec sourceTree="<group>" → relatif à ios/
  const iconDest = path.join(iosPath, CALLKIT_ICON_NAME);
  fs.copyFileSync(iconSource, iconDest);
  console.log(`[withVoIPCallKit] 🎨 CallKit icon copied: ${CALLKIT_ICON_NAME}`);

  // Ajouter au projet Xcode (pbxproj)
  const pbxprojDir = fs.readdirSync(iosPath)
    .find(f => f.endsWith('.xcodeproj'));

  if (pbxprojDir) {
    const pbxprojPath = path.join(iosPath, pbxprojDir, 'project.pbxproj');

    if (fs.existsSync(pbxprojPath)) {
      let pbxContent = fs.readFileSync(pbxprojPath, 'utf8');

      if (!pbxContent.includes(CALLKIT_ICON_NAME)) {
        // IDs déterministes pour éviter les doublons
        const fileRefId = 'CALLICON000000000001';
        const buildFileId = 'CALLICON000000000002';

        const fileRefEntry = `\t\t${fileRefId} /* ${CALLKIT_ICON_NAME} */ = {isa = PBXFileReference; lastKnownFileType = image.png; path = "${CALLKIT_ICON_NAME}"; sourceTree = "<group>"; };`;
        const buildFileEntry = `\t\t${buildFileId} /* ${CALLKIT_ICON_NAME} in Resources */ = {isa = PBXBuildFile; fileRef = ${fileRefId} /* ${CALLKIT_ICON_NAME} */; };`;

        // Insert file reference
        const fileRefMarker = '/* End PBXFileReference section */';
        pbxContent = pbxContent.replace(
          fileRefMarker,
          `${fileRefEntry}\n${fileRefMarker}`
        );

        // Insert build file
        const buildFileMarker = '/* End PBXBuildFile section */';
        pbxContent = pbxContent.replace(
          buildFileMarker,
          `${buildFileEntry}\n${buildFileMarker}`
        );

        // Add to Resources build phase
        const resourcesPhaseRegex = /(\/\* Resources \*\/ = \{[^}]*files = \(\n)/;
        pbxContent = pbxContent.replace(
          resourcesPhaseRegex,
          `$1\t\t\t\t${buildFileId} /* ${CALLKIT_ICON_NAME} in Resources */,\n`
        );

        // Add to main group children
        const mainGroupRegex = /(mainGroup = [A-F0-9]+[^;]*;[^}]*children = \(\n)/;
        pbxContent = pbxContent.replace(
          mainGroupRegex,
          `$1\t\t\t\t${fileRefId} /* ${CALLKIT_ICON_NAME} */,\n`
        );

        fs.writeFileSync(pbxprojPath, pbxContent);
        console.log(`[withVoIPCallKit] 🎨 ${CALLKIT_ICON_NAME} added to Xcode project`);
      } else {
        console.log(`[withVoIPCallKit] 🎨 ${CALLKIT_ICON_NAME} already in Xcode project`);
      }
    }
  }
}

// ═══════════════════════════════════════════════
// Bridging Header
// ═══════════════════════════════════════════════

function patchBridgingHeader(appDir, appName) {
  // Chercher un bridging header existant
  let headerPath = null;
  const files = fs.readdirSync(appDir);
  for (const f of files) {
    if (f.endsWith('-Bridging-Header.h') || f === 'Bridging-Header.h') {
      headerPath = path.join(appDir, f);
      break;
    }
  }

  // Créer si inexistant
  if (!headerPath) {
    headerPath = path.join(appDir, `${appName}-Bridging-Header.h`);
    fs.writeFileSync(headerPath, '//\n//  Bridging header for Ghostr VoIP\n//\n\n');
    console.log(`[withVoIPCallKit] Created bridging header: ${headerPath}`);
  }

  let content = fs.readFileSync(headerPath, 'utf8');
  let modified = false;

  const requiredImports = [
    '#import "RNCallKeep.h"',
    '#import "RNVoipPushNotificationManager.h"',
  ];

  for (const imp of requiredImports) {
    if (!content.includes(imp)) {
      content += `${imp}\n`;
      modified = true;
    }
  }

  if (modified) {
    fs.writeFileSync(headerPath, content);
    console.log('[withVoIPCallKit] ✅ Bridging header patched');
  } else {
    console.log('[withVoIPCallKit] Bridging header already up to date');
  }
}

// ═══════════════════════════════════════════════
// AppDelegate.swift patching
// ═══════════════════════════════════════════════

function patchAppDelegateSwift(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');

  // Déjà patché ?
  if (content.includes('GHOSTR_VOIP_CALLKIT')) {
    console.log('[withVoIPCallKit] AppDelegate.swift already patched');
    return;
  }

  // 1. Ajouter import PushKit + CallKit
  if (!content.includes('import PushKit')) {
    const lastImport = content.lastIndexOf('\nimport ');
    if (lastImport !== -1) {
      const endOfImportLine = content.indexOf('\n', lastImport + 1);
      content = content.slice(0, endOfImportLine + 1)
        + 'import PushKit\nimport CallKit\n'
        + content.slice(endOfImportLine + 1);
    } else {
      content = 'import PushKit\nimport CallKit\n' + content;
    }
  } else if (!content.includes('import CallKit')) {
    content = content.replace('import PushKit', 'import PushKit\nimport CallKit');
  }

  // 2. Ajouter VoIP registration dans didFinishLaunchingWithOptions
  const voipInit = `
    // ═══ GHOSTR_VOIP_CALLKIT: PushKit + CallKit ═══
    RNVoipPushNotificationManager.voipRegistration()
    RNCallKeep.setup([
      "appName": "Ghostr",
      "supportsVideo": false,
      "includesCallsInRecents": false,
      "maximumCallGroups": 1,
      "maximumCallsPerCallGroup": 1,
      "imageName": "GhostrCallIcon",
      "ringtoneSound": "ghostr_ringtone.mp3",
    ])
    // Initialiser l'observateur natif qui termine CallKit dès que
    // l'utilisateur appuie le bouton vert (lock screen).
    // Empêche l'écran "en appel" iOS de s'afficher.
    self.setupGhostrCallObserver()
    // ═══ END GHOSTR_VOIP_CALLKIT init ═══`;

  // Chercher le point d'insertion: avant le return de didFinishLaunchingWithOptions
  if (content.includes('return super.application(application')) {
    content = content.replace(
      /(return\s+super\.application\(application)/,
      voipInit + '\n\n    $1'
    );
  } else {
    // Pattern alternatif: résultat stocké dans une variable
    const superCallPattern = /(let\s+\w+\s*=\s*super\.application\(application)/;
    if (superCallPattern.test(content)) {
      content = content.replace(superCallPattern, voipInit + '\n\n    $1');
    } else {
      console.warn('[withVoIPCallKit] ⚠️ Could not find insertion point in didFinishLaunchingWithOptions');
    }
  }

  // 3. Ajouter l'extension PKPushRegistryDelegate à la fin du fichier
  content += SWIFT_PUSHKIT_EXTENSION;

  fs.writeFileSync(filePath, content);
  console.log('[withVoIPCallKit] ✅ AppDelegate.swift patched with PushKit + CallKit');
}

// ═══════════════════════════════════════════════
// AppDelegate.mm patching (fallback Objective-C++)
// ═══════════════════════════════════════════════

function patchAppDelegateObjCpp(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');

  if (content.includes('GHOSTR_VOIP_CALLKIT')) {
    console.log('[withVoIPCallKit] AppDelegate.mm already patched');
    return;
  }

  // 1. Ajouter imports
  if (!content.includes('#import <PushKit/PushKit.h>')) {
    content = content.replace(
      /(#import\s+.*\n)/,
      '$1#import <PushKit/PushKit.h>\n#import <CallKit/CallKit.h>\n#import "RNCallKeep.h"\n#import "RNVoipPushNotificationManager.h"\n'
    );
  }

  // 2. Ajouter PKPushRegistryDelegate au @interface si présent
  if (content.includes('@interface') && !content.includes('PKPushRegistryDelegate')) {
    content = content.replace(
      /(@interface\s+AppDelegate\s*:\s*\w+)\s*(<[^>]*>)/,
      '$1 $2'
    );
    content = content.replace(
      /(<[^>]*)(>)/,
      '$1, PKPushRegistryDelegate, CXCallObserverDelegate$2'
    );
  }

  // 3. Ajouter VoIP registration dans didFinishLaunchingWithOptions
  if (content.includes('return [super application:')) {
    const voipInitObjC = `
  // ═══ GHOSTR_VOIP_CALLKIT ═══
  [RNVoipPushNotificationManager voipRegistration];
  [RNCallKeep setup:@{
    @"appName": @"Ghostr",
    @"supportsVideo": @NO,
    @"includesCallsInRecents": @NO,
    @"maximumCallGroups": @1,
    @"maximumCallsPerCallGroup": @1,
    @"imageName": @"GhostrCallIcon",
    @"ringtoneSound": @"ghostr_ringtone.mp3",
  }];
  [self setupGhostrCallObserver];
  // ═══ END GHOSTR_VOIP_CALLKIT ═══`;

    content = content.replace(
      /(return\s+\[super\s+application:)/,
      voipInitObjC + '\n\n  $1'
    );
  }

  // 4. Ajouter les méthodes PushKit avant @end
  content = content.replace(
    /(@end\s*)$/,
    OBJC_PUSHKIT_METHODS + '\n\n$1'
  );

  fs.writeFileSync(filePath, content);
  console.log('[withVoIPCallKit] ✅ AppDelegate.mm patched with PushKit + CallKit');
}

// ═══════════════════════════════════════════════
// Swift extension code
// ═══════════════════════════════════════════════

const SWIFT_PUSHKIT_EXTENSION = `

// ═══════════════════════════════════════════════════════════════
// GHOSTR_VOIP_CALLKIT: PushKit + CallKit for VoIP Incoming Calls
// ═══════════════════════════════════════════════════════════════
//
// ARCHITECTURE (résout le problème lock screen):
//
//   CallKit est utilisé UNIQUEMENT comme notification d'appel entrant.
//   Le bouton vert CallKit = "Voir l'appel", PAS "Répondre".
//   L'appel réel est géré côté JS par call1to1Service (WebRTC E2E).
//
//   PROBLÈME: Quand l'user appuie le bouton vert sur le lock screen,
//   iOS affiche son UI "en appel" native (écran vert, timer, mute).
//   Le JS n'est pas encore démarré donc endCall() côté JS arrive trop tard.
//
//   SOLUTION: CXCallObserver observe NATIVEMENT l'état des appels.
//   Dès qu'un appel Ghostr passe en "connected" (= bouton vert appuyé),
//   on le termine IMMÉDIATEMENT côté natif via CXCallController.
//   L'UI "en appel" iOS n'a pas le temps de s'afficher.
//   iOS ouvre l'app → IncomingCallOverlay montre le vrai nom E2E.
//
// SÉCURITÉ:
//   - ghostrCallUUID identifie les appels Ghostr vs appels téléphoniques
//   - Seuls les appels Ghostr sont terminés automatiquement
//   - Nom affiché: "Ghostr · Appel chiffré" (100% générique)
//   - Le vrai nom n'apparaît qu'après déchiffrement E2E dans l'app

import CallKit

// UUID de l'appel Ghostr en cours (pour ne pas terminer les appels téléphoniques)
private var ghostrCallUUID: UUID?

// CXCallObserver pour détecter quand l'appel est "répondu" (connected)
private let ghostrCallObserver = CXCallObserver()

// Wrapper class pour le delegate CXCallObserver
// (AppDelegate ne peut pas se conformer directement car c'est une sous-classe Expo)
private class GhostrCallObserverDelegate: NSObject, CXCallObserverDelegate {
  func callObserver(_ callObserver: CXCallObserver, callChanged call: CXCall) {
    // Vérifier que c'est un appel Ghostr (pas un appel téléphonique)
    guard let ghostrUUID = ghostrCallUUID, call.uuid == ghostrUUID else { return }

    if call.hasConnected && !call.hasEnded {
      // L'utilisateur a appuyé le bouton vert → l'appel est "connecté"
      // Terminer IMMÉDIATEMENT pour éviter l'UI "en appel" iOS
      // L'app s'ouvre automatiquement (comportement iOS standard)
      let controller = CXCallController()
      let endAction = CXEndCallAction(call: call.uuid)
      let transaction = CXTransaction(action: endAction)
      controller.request(transaction) { error in
        if let error = error {
          NSLog("[Ghostr] CXCallObserver endCall error: \\(error.localizedDescription)")
        } else {
          NSLog("[Ghostr] CXCallObserver: Ghostr call ended natively (lock screen answer)")
        }
      }
      ghostrCallUUID = nil
    } else if call.hasEnded {
      // Appel terminé (decline ou fin) → cleanup
      ghostrCallUUID = nil
    }
  }
}

private let ghostrCallDelegate = GhostrCallObserverDelegate()

extension AppDelegate: PKPushRegistryDelegate {

  // Appelé au lancement pour initialiser l'observateur d'appels
  func setupGhostrCallObserver() {
    ghostrCallObserver.setDelegate(ghostrCallDelegate, queue: DispatchQueue.main)
    NSLog("[Ghostr] CXCallObserver initialized")
  }

  public func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
    RNVoipPushNotificationManager.didUpdate(pushCredentials, forType: type.rawValue)
  }

  public func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    // Token invalidé — PushKit fournira un nouveau token automatiquement
  }

  public func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
    // Générer un UUID unique pour cet appel
    let callUUID = UUID()
    let uuidString = callUUID.uuidString

    // Stocker l'UUID pour que CXCallObserver puisse identifier cet appel
    ghostrCallUUID = callUUID

    // SÉCURITÉ: Nom 100% générique — aucune donnée identifiable
    let callerName = "Ghostr \\u{00B7} Appel chiffré"
    let handle = "ghostr"

    // Stocker le completion handler pour react-native-voip-push-notification
    RNVoipPushNotificationManager.addCompletionHandler(uuidString, completionHandler: completion)

    // Notifier le JS (fire 'notification' event pour le polling E2E)
    RNVoipPushNotificationManager.didReceiveIncomingPush(with: payload, forType: type.rawValue)

    // CRITIQUE: Reporter l'appel à CallKit IMMÉDIATEMENT
    // iOS 13+ exige que reportNewIncomingCall soit appelé dans ce handler.
    // Si on ne le fait pas, iOS termine l'app.
    RNCallKeep.reportNewIncomingCall(
      uuidString,
      handle: handle,
      handleType: "generic",
      hasVideo: false,
      localizedCallerName: callerName,
      supportsHolding: false,
      supportsDTMF: false,
      supportsGrouping: false,
      supportsUngrouping: false,
      fromPushKit: true,
      payload: payload.dictionaryPayload,
      withCompletionHandler: nil
    )
  }
}
`;

// ═══════════════════════════════════════════════
// Objective-C++ PushKit methods (fallback)
// ═══════════════════════════════════════════════

const OBJC_PUSHKIT_METHODS = `
// ═══ GHOSTR_VOIP_CALLKIT: PushKit + CXCallObserver ═══

static NSUUID *_ghostrCallUUID = nil;
static CXCallObserver *_ghostrCallObserver = nil;

- (void)setupGhostrCallObserver {
  _ghostrCallObserver = [[CXCallObserver alloc] init];
  [_ghostrCallObserver setDelegate:self queue:dispatch_get_main_queue()];
  NSLog(@"[Ghostr] CXCallObserver initialized");
}

// CXCallObserverDelegate — termine l'appel Ghostr nativement dès qu'il est "répondu"
- (void)callObserver:(CXCallObserver *)callObserver callChanged:(CXCall *)call {
  if (!_ghostrCallUUID || ![call.UUID isEqual:_ghostrCallUUID]) return;

  if (call.hasConnected && !call.hasEnded) {
    CXCallController *controller = [[CXCallController alloc] init];
    CXEndCallAction *endAction = [[CXEndCallAction alloc] initWithCallUUID:call.UUID];
    CXTransaction *transaction = [[CXTransaction alloc] initWithAction:endAction];
    [controller requestTransaction:transaction completion:^(NSError *error) {
      if (error) {
        NSLog(@"[Ghostr] CXCallObserver endCall error: %@", error.localizedDescription);
      } else {
        NSLog(@"[Ghostr] CXCallObserver: Ghostr call ended natively");
      }
    }];
    _ghostrCallUUID = nil;
  } else if (call.hasEnded) {
    _ghostrCallUUID = nil;
  }
}

- (void)pushRegistry:(PKPushRegistry *)registry didUpdatePushCredentials:(PKPushCredentials *)credentials forType:(PKPushType)type {
  [RNVoipPushNotificationManager didUpdatePushCredentials:credentials forType:(NSString *)type];
}

- (void)pushRegistry:(PKPushRegistry *)registry didInvalidatePushTokenForType:(PKPushType)type {
  // Token invalidé
}

- (void)pushRegistry:(PKPushRegistry *)registry didReceiveIncomingPushWithPayload:(PKPushPayload *)payload forType:(PKPushType)type withCompletionHandler:(void (^)(void))completion {
  NSUUID *callUUID = [NSUUID UUID];
  NSString *uuidString = [callUUID UUIDString];
  _ghostrCallUUID = callUUID;

  NSString *callerName = @"Ghostr \\u00B7 Appel chiffré";
  NSString *handle = @"ghostr";

  [RNVoipPushNotificationManager addCompletionHandler:uuidString completionHandler:completion];
  [RNVoipPushNotificationManager didReceiveIncomingPushWithPayload:payload forType:(NSString *)type];

  [RNCallKeep reportNewIncomingCall:uuidString
                             handle:handle
                         handleType:@"generic"
                           hasVideo:NO
                localizedCallerName:callerName
                    supportsHolding:NO
                       supportsDTMF:NO
                   supportsGrouping:NO
                 supportsUngrouping:NO
                        fromPushKit:YES
                            payload:payload.dictionaryPayload
              withCompletionHandler:nil];
}

// ═══ END GHOSTR_VOIP_CALLKIT ═══`;

module.exports = withVoIPCallKit;