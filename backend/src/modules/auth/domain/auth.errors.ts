import { AppError } from "../../../shared/errors/index.js";

export class EmailAlreadyRegisteredError extends AppError {
  constructor() {
    super("Email is already registered", 409, "EMAIL_ALREADY_REGISTERED");
  }
}

// Deliberately identical whether the email doesn't exist or the password is
// wrong -- distinguishing the two lets an attacker enumerate registered
// emails via the login endpoint.
export class InvalidCredentialsError extends AppError {
  constructor() {
    super("Invalid email or password", 401, "INVALID_CREDENTIALS");
  }
}
