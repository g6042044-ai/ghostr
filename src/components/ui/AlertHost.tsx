// src/components/ui/AlertHost.tsx
// ════════════════════════════════════════════════════════════════════════════
// DIALOGUES IMPÉRATIFS — une seule grammaire pour toute l'application
// ════════════════════════════════════════════════════════════════════════════
//
// LE PROBLÈME
// ────────────────────────────────────────────────────────────────────────────
// L'app parlait DEUX langages de dialogue en parallèle :
//   - `AlertModal` / `ActionSheet` du design system, aux couleurs du thème,
//     avec les arrondis, la typographie et les animations de Ghostr ;
//   - une cinquantaine d'`Alert.alert()` natifs, au style de l'OS, insensibles
//     au thème de l'app, avec des boutons ordonnés différemment sur iOS et
//     Android.
//
// Le résultat : supprimer une conversation ouvrait une boîte système grise,
// tandis que supprimer un message ouvrait une modale teal aux coins arrondis.
// Deux gestes équivalents, deux apparences sans rapport.
//
// POURQUOI LES `Alert.alert` AVAIENT GAGNÉ
// ────────────────────────────────────────────────────────────────────────────
// Ce n'était pas de la négligence : `AlertModal` est un composant DÉCLARATIF.
// L'afficher depuis un handler impose un `useState` de visibilité, un second
// pour les données du dialogue, un rendu conditionnel en bas du JSX, et un
// câblage manuel de chaque bouton. Face à ça, `Alert.alert(titre, message)`
// tient sur une ligne. Le design system perdait par ergonomie, pas par
// qualité.
//
// LA SOLUTION
// ────────────────────────────────────────────────────────────────────────────
// Ce module rend le design system AUSSI simple à appeler que l'API native :
//
//   await showAlert({ title: t('common.error'), message: t('...') });
//
//   const ok = await showConfirm({
//     title: t('contactInfo.deleteConversation'),
//     message: t('contactInfo.deleteConfirmMessage'),
//     confirmText: t('common.delete'),
//     destructive: true,
//   });
//   if (ok) { … }
//
//   await showActionSheet({ title: '…', items: [{ title: '…', onPress }] });
//
// Les promesses se résolvent à la FERMETURE du dialogue, ce qui permet
// d'écrire un flux de confirmation de façon linéaire au lieu de le disperser
// dans des callbacks.
//
// ARCHITECTURE
// ────────────────────────────────────────────────────────────────────────────
// Un `<AlertHost />` unique est monté dans App.tsx. Il s'appuie sur
// `AlertModal` et `ActionSheet`, eux-mêmes basés sur le `Modal` de React
// Native : celui-ci est présenté dans SA PROPRE fenêtre native, au-dessus de
// tout, y compris des écrans déclarés `presentation: 'modal'`. Contrairement
// au Toast (une simple `View` en position absolue, cf. Toast.tsx), il n'y a
// donc pas besoin d'une pile de hosts.
//
// Les demandes sont MISES EN FILE. Deux appels rapprochés — typiquement un
// `catch` qui signale une erreur pendant qu'une confirmation est encore
// ouverte — affichent deux dialogues successifs au lieu que le second
// remplace le premier sans que l'utilisateur l'ait vu.
//
// CE QUI RESTE EN `Alert.alert`
// ────────────────────────────────────────────────────────────────────────────
// Rien dans les écrans. Le seul usage légitime restant serait un message
// affiché alors que l'arbre React n'est pas monté (crash de bootstrap), cas
// où ce host n'existe pas encore.
//
// PRIVACY
// ────────────────────────────────────────────────────────────────────────────
// Ne jamais passer de contenu de message, de clé ou d'empreinte dans `message` :
// un dialogue s'affiche par-dessus tout et apparaît dans les captures d'écran.

import React, { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';

import { AlertModal, ActionSheet } from './Modal';

// ────────────────────────────────────────────────────────────────────────────
// TYPES
// ────────────────────────────────────────────────────────────────────────────

export interface AlertButton {
  text: string;
  onPress?: () => void;
  /**
   * 'cancel' place le bouton en position secondaire, 'destructive' le peint
   * en rouge. Même vocabulaire que l'API native, pour que la conversion des
   * appels existants soit une substitution directe.
   */
  style?: 'default' | 'cancel' | 'destructive';
}

export interface AlertRequest {
  title: string;
  message?: string;
  /**
   * Un ou deux boutons. Au-delà, `AlertModal` n'a pas la place de les rendre
   * lisiblement : utiliser `showActionSheet` — c'est le composant fait pour
   * un choix parmi N.
   */
  buttons?: AlertButton[];
  /**
   * À `false`, le dialogue ne peut être fermé QUE par un de ses boutons : ni
   * tap à l'extérieur, ni bouton retour Android. Équivalent du
   * `{ cancelable: false }` de l'API native.
   *
   * Réservé aux avertissements de sécurité que l'utilisateur doit avoir vus
   * (appareil compromis, épinglage de certificat inactif) : un tap distrait à
   * côté ne doit pas valoir « j'ai lu ». Défaut : `true`.
   */
  dismissible?: boolean;
}

export interface ConfirmRequest {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  /** Peint l'action de confirmation en rouge. */
  destructive?: boolean;
}

export interface ActionSheetRequest {
  title?: string;
  subtitle?: string;
  items: Array<{
    title: string;
    subtitle?: string;
    icon?: React.ReactNode;
    onPress: () => void;
    destructive?: boolean;
    disabled?: boolean;
  }>;
  cancelText?: string;
}

type QueueEntry =
  | { kind: 'alert'; request: AlertRequest; resolve: () => void }
  | { kind: 'sheet'; request: ActionSheetRequest; resolve: () => void };

// ────────────────────────────────────────────────────────────────────────────
// BUS IMPÉRATIF
// ────────────────────────────────────────────────────────────────────────────

type Enqueue = (entry: QueueEntry) => void;

let enqueue: Enqueue | null = null;

/**
 * Retourne true si un `<AlertHost />` est monté. Utile pour décider d'un repli
 * en phase de démarrage, avant que l'arbre React soit en place.
 */
export function isAlertHostReady(): boolean {
  return enqueue !== null;
}

/**
 * Repli sur le dialogue natif quand aucun host n'est monté.
 *
 * POURQUOI CE REPLI EXISTE : certains dialogues partent pendant le bootstrap,
 * avant que l'arbre React principal soit rendu — notamment les avertissements
 * de sécurité d'App.tsx (« appareil compromis », « épinglage de certificat
 * inactif »). Résoudre silencieusement la promesse ferait DISPARAÎTRE ces
 * avertissements : l'utilisateur d'un appareil rooté ne verrait plus rien.
 *
 * Un dialogue système moins joli vaut infiniment mieux qu'un avertissement de
 * sécurité avalé. Le repli n'est jamais atteint depuis un écran : à ce
 * moment-là, le host est monté.
 */
/**
 * Libellé du bouton de fermeture du repli natif. Ce repli est justement le
 * chemin du bootstrap, où `initI18n()` peut ne pas avoir résolu : i18next
 * renverrait alors la clé brute. On retombe sur « OK », compris partout.
 */
function okLabel(): string {
  return i18n.isInitialized ? (i18n.t('common.ok') as string) : 'OK';
}

function nativeFallback(entry: QueueEntry): void {
  // La promesse doit se résoudre une fois et une seule : `onPress` et
  // `onDismiss` (Android) peuvent tous deux se déclencher selon le chemin de
  // fermeture. Un double `resolve` est sans effet sur une promesse, mais le
  // garde rend l'intention explicite et évite de rejouer l'action.
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    entry.resolve();
  };

  if (entry.kind === 'sheet') {
    const { request } = entry;
    Alert.alert(
      request.title ?? '',
      request.subtitle,
      [
        ...request.items.map((item) => ({
          text: item.title,
          onPress: () => { try { item.onPress(); } finally { settle(); } },
          style: item.destructive ? ('destructive' as const) : ('default' as const),
        })),
        { text: request.cancelText ?? okLabel(), style: 'cancel' as const, onPress: settle },
      ],
      { cancelable: true, onDismiss: settle },
    );
    return;
  }

  const { request } = entry;
  const buttons = (request.buttons ?? []).map((b) => ({
    text: b.text,
    onPress: () => { try { b.onPress?.(); } finally { settle(); } },
    style: b.style ?? ('default' as const),
  }));
  Alert.alert(
    request.title,
    request.message,
    // Sans bouton explicite, l'API native en ajoute un « OK » implicite dont
    // on ne peut pas observer l'appui — on en fournit donc un nous-mêmes pour
    // que la promesse se résolve bien à la fermeture.
    buttons.length > 0 ? buttons : [{ text: okLabel(), onPress: settle }],
    { cancelable: request.dismissible !== false, onDismiss: settle },
  );
}

function dispatch(entry: QueueEntry): void {
  if (!enqueue) {
    nativeFallback(entry);
    return;
  }
  enqueue(entry);
}

/**
 * Affiche un dialogue et résout à sa fermeture. Remplaçant direct de
 * `Alert.alert(title, message, buttons)`.
 */
export function showAlert(request: AlertRequest): Promise<void> {
  return new Promise((resolve) => {
    dispatch({ kind: 'alert', request, resolve });
  });
}

/**
 * Demande une confirmation. Résout à `true` si l'utilisateur confirme, à
 * `false` s'il annule OU s'il ferme le dialogue par un tap à l'extérieur ou
 * le bouton retour Android.
 *
 * Le défaut à `false` est délibéré : toutes les confirmations de l'app portent
 * sur des actions destructrices (supprimer une conversation, quitter un
 * groupe, réinitialiser un lien). En cas de doute, ne rien faire.
 */
export function showConfirm(request: ConfirmRequest): Promise<boolean> {
  return new Promise((resolve) => {
    let confirmed = false;
    dispatch({
      kind: 'alert',
      request: {
        title: request.title,
        message: request.message,
        buttons: [
          { text: request.cancelText ?? '', style: 'cancel' },
          {
            text: request.confirmText ?? '',
            style: request.destructive ? 'destructive' : 'default',
            onPress: () => { confirmed = true; },
          },
        ],
      },
      resolve: () => resolve(confirmed),
    });
  });
}

/** Affiche une feuille d'actions et résout à sa fermeture. */
export function showActionSheet(request: ActionSheetRequest): Promise<void> {
  return new Promise((resolve) => {
    dispatch({ kind: 'sheet', request, resolve });
  });
}

// ────────────────────────────────────────────────────────────────────────────
// HOST
// ────────────────────────────────────────────────────────────────────────────

export const AlertHost: React.FC = () => {
  const { t } = useTranslation();
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  // `visible` est distinct de « la file est non vide » : il permet de jouer
  // l'animation de sortie AVANT de retirer l'entrée de la file. Sans lui, le
  // dialogue disparaîtrait d'un coup.
  const [visible, setVisible] = useState(false);

  // `closing` est un ÉTAT, pas une ref : le rendu doit en dépendre.
  //
  // Il empêche l'effet d'ouverture ci-dessous de rouvrir immédiatement le
  // dialogue qu'on vient de fermer — au moment où `visible` repasse à false,
  // la file contient toujours l'entrée courante (elle n'est dépilée qu'à la
  // fin de l'animation de sortie), donc la condition « file non vide et rien
  // d'affiché » serait vraie et relancerait le même dialogue en boucle.
  //
  // Une ref ne suffirait pas : la remettre à false ne déclenche aucun rendu,
  // donc l'effet ne serait pas réévalué et le dialogue suivant de la file ne
  // s'ouvrirait jamais.
  const [closing, setClosing] = useState(false);

  // Garde anti double-fermeture pendant le même cycle : deux taps rapprochés
  // sur le fond et un bouton ne doivent jouer qu'une action.
  const closeGuard = useRef(false);

  useEffect(() => {
    enqueue = (entry: QueueEntry) => {
      setQueue((prev) => [...prev, entry]);
    };
    return () => {
      enqueue = null;
    };
  }, []);

  // Dès qu'une entrée est en tête de file et qu'aucun dialogue n'est affiché
  // ni en cours de fermeture, on l'ouvre.
  useEffect(() => {
    if (queue.length > 0 && !visible && !closing) {
      setVisible(true);
    }
  }, [queue, visible, closing]);

  const current = queue[0];

  /**
   * Ferme le dialogue courant : joue l'action choisie, résout la promesse,
   * puis dépile UNE FOIS L'ANIMATION DE SORTIE TERMINÉE.
   *
   * Le dépilement différé est essentiel : si on retirait l'entrée tout de
   * suite, `current` deviendrait l'entrée suivante (ou `undefined`) pendant
   * que le dialogue s'efface. L'utilisateur verrait le texte changer en
   * pleine disparition, ou la modale s'évanouir d'un coup.
   */
  //
  // `close` est RECRÉÉ à chaque rendu, volontairement : il doit voir le
  // `current` du rendu en cours. Un `useCallback([])` capturerait la première
  // entrée de la file pour toujours. Le coût est nul — les seuls
  // consommateurs sont les boutons de la modale affichée.
  const close = (action?: () => void) => {
    if (closeGuard.current) return;
    closeGuard.current = true;

    setClosing(true);
    setVisible(false);

    // L'action et la résolution sont jouées ICI, dans le gestionnaire
    // d'événement — surtout PAS à l'intérieur d'un updater `setState`. Un
    // updater doit être pur : React se réserve le droit de l'appeler
    // plusieurs fois (c'est ce que fait le mode strict en développement),
    // ce qui rejouerait l'action de l'utilisateur — supprimer deux fois,
    // envoyer deux fois, quitter deux fois.
    //
    // Si l'action ouvre elle-même un dialogue (« supprimer » → « échec de la
    // suppression »), le `showAlert` correspondant empile simplement une
    // entrée ; elle s'affichera à la fin de l'animation de sortie en cours.
    if (current) {
      try {
        action?.();
      } finally {
        current.resolve();
      }
    }

    // 220 ms couvre le fondu d'`AlertModal` et le glissement d'`ActionSheet`.
    setTimeout(() => {
      closeGuard.current = false;
      // Les deux `set` sont groupés par React : l'effet d'ouverture ne
      // s'exécute qu'une fois, avec la file déjà dépilée.
      setQueue((prev) => prev.slice(1));
      setClosing(false);
    }, 220);
  };

  if (!current) return null;

  if (current.kind === 'sheet') {
    const { request } = current;
    return (
      <ActionSheet
        visible={visible}
        onClose={() => close()}
        title={request.title}
        subtitle={request.subtitle}
        cancelText={request.cancelText ?? t('common.cancel')}
        // Les `onPress` sont passés TELS QUELS, sans les rerouter par
        // `close(item.onPress)` : contrairement à `AlertModal`, `ActionSheet`
        // gère lui-même la fermeture. Son `handleItemPress` appelle `onClose()`
        // (→ `close()` ici, qui résout la promesse et fait avancer la file)
        // PUIS diffère `item.onPress()` au tick suivant. Un second passage par
        // `close(...)` heurterait le `closeGuard` armé par ce premier appel et
        // l'action de l'item serait silencieusement avalée.
        items={request.items}
      />
    );
  }

  const { request } = current;
  const buttons = request.buttons ?? [];

  // Un seul bouton (ou aucun) → dialogue purement informatif avec « OK ».
  const single = buttons.length <= 1;
  const primarySource = single ? buttons[0] : buttons.find((b) => b.style !== 'cancel') ?? buttons[1];
  const secondarySource = single ? undefined : buttons.find((b) => b.style === 'cancel') ?? buttons[0];

  return (
    <AlertModal
      visible={visible}
      // Fermeture par tap à l'extérieur / bouton retour Android : on ne joue
      // AUCUNE action. Fermer n'est pas choisir. Et si le dialogue est
      // marqué non dismissible, ces gestes sont purement et simplement
      // ignorés — seul un bouton peut le refermer.
      onClose={() => { if (request.dismissible !== false) close(); }}
      title={request.title}
      message={request.message ?? ''}
      primaryButton={{
        title: primarySource?.text || t('common.ok'),
        onPress: () => close(primarySource?.onPress),
        variant: primarySource?.style === 'destructive' ? 'danger' : 'primary',
      }}
      secondaryButton={
        secondarySource
          ? {
              title: secondarySource.text || t('common.cancel'),
              onPress: () => close(secondarySource.onPress),
            }
          : undefined
      }
    />
  );
};

export default AlertHost;
