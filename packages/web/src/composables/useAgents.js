import { ref } from 'vue';

export function useAgents() {
  const agents = ref([]);
  const loading = ref(false);
  const error = ref(null);

  async function fetchAgents() {
    loading.value = true;
    error.value = null;
    try {
      const res = await fetch('/api/agents');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      agents.value = data.agents || [];
    } catch (e) {
      error.value = e.message;
    } finally {
      loading.value = false;
    }
  }

  async function rescan() {
    loading.value = true;
    error.value = null;
    try {
      const res = await fetch('/api/agents/rescan', { method: 'POST' });
      const data = await res.json();
      agents.value = data.agents || [];
    } catch (e) {
      error.value = e.message;
    } finally {
      loading.value = false;
    }
  }

  return { agents, loading, error, fetchAgents, rescan };
}
