import { listEvents as listEventsQuery } from "../infrastructure/catalog.repository.js";

export async function listEvents() {
  return listEventsQuery();
}
