export function schedulePollingTask({ schedule, delayMs, task, onFailure }) {
  return schedule(() => {
    void Promise.resolve()
      .then(task)
      .catch(onFailure);
  }, delayMs);
}
