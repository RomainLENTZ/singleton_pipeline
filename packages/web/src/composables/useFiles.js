import { ref } from 'vue';

export function useFiles() {
  const files = ref([]);
  const loading = ref(false);
  const error = ref('');

  async function fetchFiles(ext = 'md') {
    loading.value = true;
    error.value = '';
    try {
      const res = await fetch(`/api/files?ext=${encodeURIComponent(ext)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'list failed');
      files.value = data.files || [];
    } catch (e) {
      error.value = e.message;
      files.value = [];
    } finally {
      loading.value = false;
    }
  }

  return { files, loading, error, fetchFiles };
}
