<script setup lang="ts">
const title = 'Example product'
</script>

<template>
  <main class="home">
    <section class="home__hero">
      <h1>{{ title }}</h1>
      <p>Small fixture used by the frontend audit example.</p>
    </section>
  </main>
</template>

<style lang="scss" scoped>
.home {
  padding: 64px 24px;
}

.home__hero {
  max-width: 720px;
  margin: 0 auto;
}
</style>
