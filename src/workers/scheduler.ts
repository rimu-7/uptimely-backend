import { runProbeCycle } from "./probe.worker";
import { runHeartbeatSweeper } from "./heartbeat.worker";
import { runHourlyRollups } from "./rollup.worker";

export class WorkerScheduler {
  private static isProbing = false;
  private static isSweeping = false;
  private static isRolling = false;

  static startAll() {
    console.log("⚙️ [Scheduler] Starting background worker loops...");
    this.startProbeLoop();
    this.startHeartbeatLoop();
    this.startRollupLoop();
  }

  private static startProbeLoop() {
    const probeLoop = async () => {
      if (!this.isProbing) {
        this.isProbing = true;
        try {
          await runProbeCycle();
        } catch (err: any) {
          console.error("❌ [Probe Worker Exception]", err.message || err);
        } finally {
          this.isProbing = false;
        }
      }
      setTimeout(probeLoop, 10_000);
    };
    probeLoop();
  }

  private static startHeartbeatLoop() {
    const heartbeatLoop = async () => {
      if (!this.isSweeping) {
        this.isSweeping = true;
        try {
          await runHeartbeatSweeper();
        } catch (err: any) {
          console.error("❌ [Heartbeat Worker Exception]", err.message || err);
        } finally {
          this.isSweeping = false;
        }
      }
      setTimeout(heartbeatLoop, 5_000);
    };
    heartbeatLoop();
  }

  private static startRollupLoop() {
    const rollupLoop = async () => {
      if (!this.isRolling) {
        this.isRolling = true;
        try {
          await runHourlyRollups();
        } catch (err: any) {
          console.error("❌ [Rollup Worker Exception]", err.message || err);
        } finally {
          this.isRolling = false;
        }
      }
      setTimeout(rollupLoop, 3_600_000);
    };
    rollupLoop();
  }
}
