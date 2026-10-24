// Shared display types only. Credentials and executable SQL never enter this module.
export type Row = Record<string, string | number | null>;
export interface Database {
  id: string;
  name: string;
  accountId: string;
  environment: "preview" | "protected";
}
export interface SchemaTable {
  name: string;
  columns: string[];
}
export interface Inspection {
  database: Database;
  tables: SchemaTable[];
  compatible: boolean;
  missing: string[];
  metadata: Record<string, unknown>;
  unlockedUntil: number;
}
export interface User extends Row {
  id: string;
  name: string;
  email: string;
  role: string;
  verified: number;
  active: number;
  applicationApproved: number;
  patrolApproved: number;
  submitted: number;
  orientationCompleted: number;
  updatedAt: number;
  statusUpdatedAt: number;
}
export type Action =
  | "role"
  | "access"
  | "revoke-sessions"
  | "delete-user"
  | "event-visibility"
  | "event-capacity"
  | "cancel-event"
  | "remove-registration"
  | "complete-orientation";
export interface ActionInput {
  action: Action;
  id: string;
  value?: string | number | boolean;
  field?:
    "active" | "applicationApproved" | "patrolApproved" | "open" | "hidden";
}
export interface Plan {
  token: string;
  title: string;
  details: string[];
  impact: { label: string; count: number }[];
  confirmation: string;
  blocked: string[];
  expiresAt: number;
}
export interface AuditEntry {
  id: string;
  time: string;
  operator: string;
  database: string;
  action: string;
  subject?: string;
  outcome: "started" | "succeeded" | "failed" | "unknown";
  code?: string;
}
export interface Overview {
  counts: Row;
  queues: { name: string; rows: Row[]; recent: Row[] }[];
  events: Row[];
  series: Row[];
  warnings: string[];
  loadedAt: number;
}
