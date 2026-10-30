ALTER TABLE "opportunities" ADD COLUMN "business_category" TEXT;
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_business_category_check"
  CHECK ("business_category" IN ('restaurant', 'cafe', 'salon', 'mobile_shop', 'takeaway', 'other'));
CREATE INDEX "opportunities_business_category_stage_id_idx" ON "opportunities"("business_category", "stage_id");

WITH aliases(alias, category) AS (
  VALUES ('restaurant','restaurant'),('restaurants','restaurant'),('cafe','cafe'),('cafes','cafe'),
    ('salon','salon'),('salons','salon'),('hair salon','salon'),('hair salons','salon'),('beauty salon','salon'),('beauty salons','salon'),
    ('mobile shop','mobile_shop'),('mobile shops','mobile_shop'),('mobile phone shop','mobile_shop'),('mobile phone shops','mobile_shop'),
    ('takeaway','takeaway'),('takeaways','takeaway'),('take away','takeaway'),('take aways','takeaway'),('other','other')
), candidates AS (
  SELECT c.id, a.category
  FROM "customers" c
  CROSS JOIN LATERAL (VALUES (c.business_type), (c.industry)) AS source(value)
  JOIN aliases a ON a.alias = regexp_replace(regexp_replace(lower(translate(trim(source.value), 'éÉ', 'ee')), '[_-]+', ' ', 'g'), '\s+', ' ', 'g')
), unambiguous AS (
  SELECT id, min(category) AS category FROM candidates GROUP BY id HAVING count(DISTINCT category) = 1
)
UPDATE "opportunities" o SET "business_category" = u.category
FROM unambiguous u WHERE o.customer_id = u.id AND o.business_category IS NULL;
