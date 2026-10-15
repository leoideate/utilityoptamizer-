-- Indexes for the opportunity list sort and the customer visibility filter.
CREATE INDEX "opportunities_updated_at_idx" ON "opportunities"("updated_at");
CREATE INDEX "customers_created_by_id_idx" ON "customers"("created_by_id");
