// Has run() and execute() but extends no BaseTask: the registry must refuse it.
export default class DynamicNotATask {
  async run() {
    return { success: true };
  }

  async execute() {
    return { success: true };
  }
}
