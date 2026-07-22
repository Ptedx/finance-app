import { type Request, type Response } from 'express';

export const login = async (req: Request, res: Response) => {
  // TODO: Implement actual login logic with Prisma and JWT
  res.status(200).json({ message: 'Login endpoint skeleton' });
};

export const register = async (req: Request, res: Response) => {
  // TODO: Implement actual register logic
  res.status(201).json({ message: 'Register endpoint skeleton' });
};
