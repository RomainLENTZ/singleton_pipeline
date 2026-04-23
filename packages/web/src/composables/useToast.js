import { ref } from 'vue';

const messages = ref([]);
let counter = 0;

export function useToast() {
  function push(text, kind = 'info', ttl = 4000) {
    const id = ++counter;
    messages.value = [...messages.value, { id, text, kind }];
    setTimeout(() => {
      messages.value = messages.value.filter((m) => m.id !== id);
    }, ttl);
  }
  return { messages, push };
}
