import { parentPort, workerData } from "node:worker_threads";
import { blockText } from "@recense/core";

parentPort?.postMessage(blockText(workerData));
