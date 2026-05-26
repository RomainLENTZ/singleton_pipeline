import { ref } from 'vue';

export function useAgents() {
  /** @type {import('vue').Ref<any[]>} */
  const agents = ref([]);
  const loading = ref(false);
  /** @type {import('vue').Ref<string | null>} */
  const error = ref(null);

  async function fetchAgents() {
    loading.value = true;
    error.value = null;
    try {
      const res = await fetch('/api/agents');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = /** @type {{ agents?: any[] }} */ (await res.json());
      agents.value = data.agents || [];
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  async function rescan() {
    loading.value = true;
    error.value = null;
    try {
      const res = await fetch('/api/agents/rescan', { method: 'POST' });
      const data = /** @type {{ agents?: any[] }} */ (await res.json());
      agents.value = data.agents || [];
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  return { agents, loading, error, fetchAgents, rescan };
}
