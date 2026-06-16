// src/lib/hmis-integration/adapters/base-adapter.ts

import { StandardizedPatient, HMISConfig } from "../types";

export interface IHMISAdapter {
  fetchPatients(config: HMISConfig): Promise<StandardizedPatient[]>;
}
