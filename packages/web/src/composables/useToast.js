import { ref } from 'vue';

/**
 * @typedef {object} ToastMessage
 * @property {number} id
 * @property {string} text
 * @property {string} kind
 */

/** @type {import('vue').Ref<ToastMessage[]>} */
const messages = ref([]);
let counter = 0;

export function useToast() {
  /**
   * @param {string} text
   * @param {string} [kind]
   * @param {number} [ttl]
   */
  function push(text, kind = 'info', ttl = 4000) {
    const id = ++counter;
    messages.value = [...messages.value, { id, text, kind }];
    setTimeout(() => {
      messages.value = messages.value.filter((m) => m.id !== id);
    }, ttl);
  }
  return { messages, push };
}
