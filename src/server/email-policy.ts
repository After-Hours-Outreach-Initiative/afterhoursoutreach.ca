export const emailPolicy = {
  // Sign-in and event mail share a budget below the provider's 100/day quota.
  dailyLimit: 80,
  budgetWindowMs: 24 * 60 * 60 * 1000,
  timeoutMs: 10 * 1000,
};
