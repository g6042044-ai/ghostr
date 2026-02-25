// src/types/libsodium-wrappers.d.ts
// Déclaration de type minimale pour libsodium-wrappers.
// Utilisé uniquement si @types/libsodium-wrappers n'est pas installé.
// Ce fichier peut être supprimé après `npm install @types/libsodium-wrappers`.

declare module 'libsodium-wrappers' {
  export const ready: Promise<void>;
  export function memzero(buf: Uint8Array): void;
  export default {
    ready: Promise<void>,
    memzero: (buf: Uint8Array) => void,
  };
}