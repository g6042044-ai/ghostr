// src/services/messageStatus.ts
// Types de statut de message
//
// v13.0 - NETTOYAGE:
//   - Suppression des fonctions legacy d'envoi (sendDeliveryReceipt, sendReadReceipt, sendReaction)
//     qui utilisaient doubleRatchetStorage/unifiedEncryption (sealed_v9)
//   - Le système actif (api1to1.ts) a ses propres implémentations
//   - Seul le type MessageStatus est conservé (utilisé par ConversationScreen + useUnifiedMessages)

export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read';