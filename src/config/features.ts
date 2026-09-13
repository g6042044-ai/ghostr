// src/config/features.ts
// ════════════════════════════════════════════════════════════════════════════
// DRAPEAUX DE FONCTIONNALITÉ
//
// Interrupteurs de PRODUIT, pas de configuration utilisateur : ils décident de
// ce qui est exposé dans l'UI d'une version donnée. Le code désactivé reste
// compilé et typé — c'est délibéré : un `if (false)` que le compilateur
// vérifie ne pourrit pas, contrairement à du code commenté.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Conversations de GROUPE — désactivées pour la première publication.
 *
 * Périmètre exact de la désactivation : uniquement les POINTS D'ACCÈS UI.
 * Aucun service n'est modifié — `groupService`, `apiGroups`, le codec
 * d'invitation, le fan-out Sender Key, la réconciliation de roster, la
 * migration (export/import des groupes) et le dispatch des messages `group_*`
 * dans `api1to1` restent intacts et fonctionnels. Le backend est donc prêt
 * pour la version suivante : repasser ce drapeau à `true` restaure la
 * fonctionnalité complète, sans autre modification.
 *
 * Ce qui est neutralisé quand `false` (chercher `GROUPS_ENABLED` pour la
 * liste exhaustive — chaque point porte le commentaire d'ancrage
 * « [GROUPES DÉSACTIVÉS] ») :
 *   - App.tsx .......................... enregistrement des 5 écrans de groupe
 *                                        dans le Stack de navigation
 *   - ConversationListScreen ........... bouton « Nouveau groupe » de l'état
 *                                        vide, entrée du menu du FAB, fusion
 *                                        des groupes dans la liste (snapshot
 *                                        initial + chargement complet),
 *                                        masquage des 1:1 vides de membres de
 *                                        groupe, abonnement `onGroupUpdate`
 *   - Join1to1Screen ................... redirection vers `JoinGroup` quand une
 *                                        invitation de groupe est scannée ou
 *                                        collée
 *   - ConversationScreen ............... ouverture de `GroupInfo` depuis
 *                                        l'en-tête, file d'approbation des
 *                                        demandes de jonction
 *
 * Le type est annoté `boolean` (et non le littéral `false`) à dessein : sans
 * ça, TypeScript réduit chaque garde à `false` et signale le code de groupe
 * comme inatteignable, ce qui masquerait de vraies erreurs de type dedans.
 */
export const GROUPS_ENABLED: boolean = false;
