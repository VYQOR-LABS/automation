import { randomUUID } from 'node:crypto';

export type CreateUserInput = {
  whatsappPhone?: string;
  email?: string;
  fullName?: string;
  displayName?: string;
};

export class UserService {
  async createUser(input: CreateUserInput) {
    return {
      id: randomUUID(),
      whatsappPhone: input.whatsappPhone ?? null,
      email: input.email ?? null,
      fullName: input.fullName ?? null,
      displayName: input.displayName ?? null,
      status: 'active',
      createdAt: new Date().toISOString(),
    };
  }

  async getUser(userId: string) {
    return {
      id: userId,
      status: 'active',
      profile: {
        fullName: 'Vico User',
      },
    };
  }
}
