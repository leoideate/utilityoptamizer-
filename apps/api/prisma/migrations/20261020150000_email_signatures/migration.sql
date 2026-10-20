-- CreateTable
CREATE TABLE "email_signatures" (
    "user_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "full_name" TEXT NOT NULL,
    "job_title" TEXT,
    "phone" TEXT,
    "mobile" TEXT,
    "email" TEXT,
    "extra" TEXT,
    "image" TEXT NOT NULL DEFAULT 'company',
    "image_width" INTEGER NOT NULL DEFAULT 160,
    "accent_color" TEXT NOT NULL DEFAULT '#036b5c',
    "show_company" BOOLEAN NOT NULL DEFAULT true,
    "own_image_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_signatures_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "email_images" (
    "id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploaded_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_images_storage_key_key" ON "email_images"("storage_key");

-- AddForeignKey
ALTER TABLE "email_signatures" ADD CONSTRAINT "email_signatures_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

