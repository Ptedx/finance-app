-- CreateEnum
CREATE TYPE "CategoryType" AS ENUM ('expense', 'income');

-- CreateEnum
CREATE TYPE "RecurrenceType" AS ENUM ('weekly', 'monthly', 'yearly');

-- CreateEnum
CREATE TYPE "AssetType" AS ENUM ('checking', 'savings', 'brokerage', 'real_estate', 'vehicle', 'other');

-- CreateEnum
CREATE TYPE "LiabilityType" AS ENUM ('credit_card', 'loan', 'mortgage', 'other');

-- CreateEnum
CREATE TYPE "GoalStatus" AS ENUM ('active', 'completed', 'paused');

-- CreateEnum
CREATE TYPE "AssetClass" AS ENUM ('renda_fixa', 'acoes_br', 'fiis', 'exterior', 'cripto');

-- CreateEnum
CREATE TYPE "PassiveIncomeType" AS ENUM ('dividend', 'interest', 'rent');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseCurrency" TEXT NOT NULL DEFAULT 'BRL',
    "language" TEXT NOT NULL DEFAULT 'pt-BR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "type" "CategoryType" NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "categories_pkey" PRIMARY KEY ("userId","id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "date" VARCHAR(10) NOT NULL,
    "note" TEXT,
    "isIncome" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("userId","id")
);

-- CreateTable
CREATE TABLE "recurring_transactions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "isIncome" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "category" TEXT NOT NULL,
    "recurrenceType" "RecurrenceType" NOT NULL,
    "day" INTEGER,
    "month" INTEGER,
    "weekday" INTEGER,
    "lastProcessed" VARCHAR(10),
    "nextDue" VARCHAR(10),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "recurring_transactions_pkey" PRIMARY KEY ("userId","id")
);

-- CreateTable
CREATE TABLE "budgets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "budgets_pkey" PRIMARY KEY ("userId","id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AssetType" NOT NULL,
    "balanceCents" BIGINT NOT NULL,
    "lastUpdated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "liabilities" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "LiabilityType" NOT NULL,
    "balanceCents" BIGINT NOT NULL,
    "dueDate" VARCHAR(10),
    "lastUpdated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "liabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "net_worth_snapshots" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" VARCHAR(10) NOT NULL,
    "totalAssetsCents" BIGINT NOT NULL,
    "totalLiabilitiesCents" BIGINT NOT NULL,
    "netWorthCents" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "net_worth_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goals" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "targetAmountCents" BIGINT NOT NULL,
    "currentAmountCents" BIGINT NOT NULL DEFAULT 0,
    "targetDate" VARCHAR(10),
    "icon" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "status" "GoalStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portfolio_allocations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assetClass" "AssetClass" NOT NULL,
    "targetBasisPoints" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "portfolio_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "passive_incomes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assetName" TEXT NOT NULL,
    "type" "PassiveIncomeType" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "date" VARCHAR(10) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "passive_incomes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE INDEX "categories_userId_updatedAt_idx" ON "categories"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "transactions_userId_updatedAt_idx" ON "transactions"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "transactions_userId_date_idx" ON "transactions"("userId", "date");

-- CreateIndex
CREATE INDEX "recurring_transactions_userId_updatedAt_idx" ON "recurring_transactions"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "budgets_userId_updatedAt_idx" ON "budgets"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "assets_userId_idx" ON "assets"("userId");

-- CreateIndex
CREATE INDEX "liabilities_userId_idx" ON "liabilities"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "net_worth_snapshots_userId_date_key" ON "net_worth_snapshots"("userId", "date");

-- CreateIndex
CREATE INDEX "goals_userId_idx" ON "goals"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "portfolio_allocations_userId_assetClass_key" ON "portfolio_allocations"("userId", "assetClass");

-- CreateIndex
CREATE INDEX "passive_incomes_userId_date_idx" ON "passive_incomes"("userId", "date");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_transactions" ADD CONSTRAINT "recurring_transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liabilities" ADD CONSTRAINT "liabilities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "net_worth_snapshots" ADD CONSTRAINT "net_worth_snapshots_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolio_allocations" ADD CONSTRAINT "portfolio_allocations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "passive_incomes" ADD CONSTRAINT "passive_incomes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
