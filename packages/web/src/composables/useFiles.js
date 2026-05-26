import { ref } from 'vue';

export function useFiles() {
  /** @type {import('vue').Ref<string[]>} */
  const files = ref([]);
  const loading = ref(false);
  const error = ref('');

  async function fetchFiles(ext = 'md') {
    loading.value = true;
    error.value = '';
    try {
      const res = await fetch(`/api/files?ext=${encodeURIComponent(ext)}`);
      const data = /** @type {{ files?: string[], error?: string }} */ (await res.json());
      if (!res.ok) throw new Error(data.error || 'list failed');
      files.value = data.files || [];
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      files.value = [];
    } finally {
      loading.value = false;
    }
  }

  return { files, loading, error, fetchFiles };
}
