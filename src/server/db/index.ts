import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

// Construct this inside each request; never share a request's binding globally.
export const createDatabase = (binding: Env["DB"]) =>
  drizzle(binding, { schema });
