-- CreateIndex
CREATE INDEX "sync_runs_triggeredById_idx" ON "sync_runs"("triggeredById");

-- AddForeignKey
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
