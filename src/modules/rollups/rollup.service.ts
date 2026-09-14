import { runHourlyRollups } from "../../workers/rollup.worker";

export class RollupService {
  static async triggerRollups() {
    await runHourlyRollups();
    return {
      status: "success",
      message: "Hourly rollups executed successfully.",
      timestamp: new Date().toISOString(),
    };
  }
}
