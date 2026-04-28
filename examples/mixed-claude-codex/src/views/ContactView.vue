<template>
  <section class="contact-view">
    <p class="contact-view__eyebrow">Studio Singleton</p>
    <h1 class="contact-view__title">Contact us</h1>
    <p class="contact-view__lead">
      Tell us about your next product, workflow, or automation idea. We will come
      back with a focused plan and the right next step.
    </p>
    <button class="contact-view__cta">Start a conversation</button>
  </section>
</template>

<style scoped>
.contact-view {
  display: grid;
  gap: 1rem;
  padding: 2rem;
  background: var(--color-bg, #111827);
  color: var(--color-text-primary, #f8fafc);
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 1.5rem;
  box-shadow: 0 18px 50px rgba(15, 23, 42, 0.22);
}

.contact-view__eyebrow {
  margin: 0;
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--color-accent, #c084fc);
}

.contact-view__title {
  margin: 0;
  font-size: clamp(2rem, 4vw, 3rem);
  line-height: 0.95;
}

.contact-view__lead {
  max-width: 40rem;
  margin: 0;
  font-size: 1rem;
  line-height: 1.7;
  color: rgba(248, 250, 252, 0.82);
}

.contact-view__cta {
  width: fit-content;
  padding: 0.875rem 1.25rem;
  border: 0;
  border-radius: 999px;
  background: linear-gradient(135deg, #c084fc 0%, #f9a8d4 100%);
  color: #111827;
  font-weight: 700;
  cursor: pointer;
  transition: transform 160ms ease, box-shadow 160ms ease;
}

.contact-view__cta:hover {
  transform: translateY(-1px);
  box-shadow: 0 12px 24px rgba(192, 132, 252, 0.28);
}
</style>
