/**
 * Module wiring. Cross-cutting services (config, prisma, crypto, audit, notifications, storage,
 * job queue, opportunity access/stages, activities) are global; feature modules own their
 * services and controllers.
 */
import Anthropic from "@anthropic-ai/sdk";
import { Global, Module } from "@nestjs/common";
import { ENV, type Env, ocrProvider } from "./config/env";
import { ActivitiesController } from "./activities/activities.controller";
import { ActivitiesService } from "./activities/activities.service";
import { BillReadingController } from "./ai/bill-reading.controller";
import { AssistantController } from "./assistant/assistant.controller";
import { AttentionController } from "./attention/attention.controller";
import { AttentionService } from "./attention/attention.service";
import { ASSISTANT_MODEL, AssistantService } from "./assistant/assistant.service";
import { AssistantTools } from "./assistant/tools";
import { BillReadingService } from "./ai/bill-reading.service";
import { ClaudeDocumentReader, DOCUMENT_READER, type DocumentReader, UnconfiguredDocumentReader } from "./ai/document-reader";
import { AdminController } from "./admin/admin.controller";
import { AdminService } from "./admin/admin.service";
import { RetentionService } from "./admin/retention.service";
import { AuditService } from "./audit/audit.service";
import { CallsModule } from "./calls/calls.module";
import { ChatModule } from "./chat/chat.module";
import { MigrationService } from "./migration/migration.service";
import { AutomationsService } from "./automations/automations.service";
import { RenewalsService } from "./automations/renewals.service";
import { CustomersController } from "./customers/customers.controller";
import { CustomersService } from "./customers/customers.service";
import { DocumentsController } from "./documents/documents.controller";
import { DocumentsService } from "./documents/documents.service";
import { EnergyController } from "./energy/energy.controller";
import { EnergyService } from "./energy/energy.service";
import { HealthController } from "./health/health.controller";
import { HelpController } from "./help/help.controller";
import {
  DisabledWhatsApp,
  EMAIL_SENDER,
  EmailSubmissionChannel,
  type EmailSender,
  MetaCloudWhatsApp,
  SUBMISSION_CHANNEL,
  SmtpEmailSender,
  WHATSAPP_SENDER,
} from "./integrations/adapters";
import { IntegrationsController } from "./integrations/integrations.controller";
import { IntegrationsService } from "./integrations/integrations.service";
import { MailboxesModule } from "./mailboxes/mailboxes.module";
import { MailboxesService } from "./mailboxes/mailboxes.service";
import { MailboxEmailSender } from "./mailboxes/system-sender";
import { MerchantController } from "./merchant/merchant.controller";
import { MerchantService } from "./merchant/merchant.service";
import { NotificationsService } from "./notifications/notifications.service";
import { OcrController } from "./ocr/ocr.controller";
import { OcrService } from "./ocr/ocr.service";
import { AiOcrProvider, HttpOcrProvider, ManualOcrProvider, OCR_PROVIDER } from "./ocr/providers";
import { OpportunityAccess } from "./opportunities/access.service";
import { LeadIntakeController, LeadIntakeService } from "./opportunities/lead-intake";
import { OpportunitiesController } from "./opportunities/opportunities.controller";
import { OpportunitiesService } from "./opportunities/opportunities.service";
import { StagesService } from "./opportunities/stages.service";
import { ReportsController } from "./reports/reports.controller";
import { ReportsService } from "./reports/reports.service";
import { ManualSignatureProvider, SIGNATURE_PROVIDER } from "./signatures/provider";
import { FormsController } from "./forms/forms.controller";
import { EmailSignaturesController } from "./email-signatures/email-signatures.controller";
import { EmailSignaturesService } from "./email-signatures/email-signatures.service";
import { FormsService } from "./forms/forms.service";
import { SigningController } from "./forms/signing.controller";
import { SigningService } from "./forms/signing.service";
import { ApplicationDocuments } from "./supplier-applications/application-documents";
import { BordGaisElectricityController } from "./supplier-applications/bord-gais-electricity/bord-gais-electricity.controller";
import { BordGaisElectricityService } from "./supplier-applications/bord-gais-electricity/bord-gais-electricity.service";
import { FlogasElectricityController } from "./supplier-applications/flogas-electricity/flogas-electricity.controller";
import { FlogasElectricityService } from "./supplier-applications/flogas-electricity/flogas-electricity.service";
import { SignaturesController } from "./signatures/signatures.controller";
import { SignaturesService } from "./signatures/signatures.service";
import { WorkflowsController } from "./workflows/workflows.controller";
import { WorkflowsService } from "./workflows/workflows.service";

@Global()
@Module({
  providers: [AuditService, NotificationsService, OpportunityAccess, StagesService, ActivitiesService],
  exports: [AuditService, NotificationsService, OpportunityAccess, StagesService, ActivitiesService],
})
export class CoreModule {}

@Module({
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}

@Module({ controllers: [CustomersController], providers: [CustomersService], exports: [CustomersService] })
export class CustomersModule {}

@Module({ controllers: [EnergyController], providers: [EnergyService], exports: [EnergyService] })
export class EnergyModule {}

@Module({
  // The CSV import creates customers and supply sites for the leads it brings in.
  imports: [DocumentsModule, CustomersModule, EnergyModule],
  controllers: [LeadIntakeController, OpportunitiesController, ActivitiesController],
  providers: [OpportunitiesService, LeadIntakeService],
  exports: [OpportunitiesService],
})
export class OpportunitiesModule {}

/** The one-off master sheet migration, run by scripts/migrate-*.ts. No routes. */
@Module({ imports: [DocumentsModule, CustomersModule], providers: [MigrationService], exports: [MigrationService] })
export class MigrationModule {}

@Module({ controllers: [MerchantController], providers: [MerchantService] })
export class MerchantModule {}

@Module({
  imports: [DocumentsModule],
  controllers: [SignaturesController],
  providers: [SignaturesService, { provide: SIGNATURE_PROVIDER, useFactory: () => new ManualSignatureProvider() }],
})
export class SignaturesModule {}

@Module({ imports: [OpportunitiesModule], controllers: [WorkflowsController], providers: [WorkflowsService] })
export class WorkflowsModule {}

/** AI document reading (Claude): "Read bill" on energy bills, and the business card reader. */
@Module({
  controllers: [BillReadingController],
  providers: [
    BillReadingService,
    {
      provide: DOCUMENT_READER,
      inject: [ENV],
      useFactory: (env: Env) => (env.ANTHROPIC_API_KEY ? ClaudeDocumentReader.create(env.ANTHROPIC_API_KEY, env.AI_MODEL) : new UnconfiguredDocumentReader()),
    },
  ],
  exports: [DOCUMENT_READER],
})
export class AiModule {}

/** "Ask the CRM": a read-only assistant that looks things up with the asker's own access. */
@Module({
  imports: [OpportunitiesModule, DocumentsModule, EnergyModule],
  controllers: [AssistantController],
  providers: [
    AssistantService,
    AssistantTools,
    {
      provide: ASSISTANT_MODEL,
      inject: [ENV],
      // Without the key the routes 404 (AssistantEnabledGuard), so the client is never called.
      useFactory: (env: Env) => new Anthropic({ apiKey: env.ANTHROPIC_API_KEY ?? "unset", timeout: 60_000, maxRetries: 2 }).messages,
    },
  ],
})
export class AssistantModule {}

@Module({
  imports: [CustomersModule, OpportunitiesModule, AiModule],
  controllers: [OcrController],
  providers: [
    OcrService,
    {
      provide: OCR_PROVIDER,
      inject: [ENV, DOCUMENT_READER],
      useFactory: (env: Env, reader: DocumentReader) => {
        const provider = ocrProvider(env);
        if (provider === "http") return new HttpOcrProvider(env.OCR_HTTP_ENDPOINT!, env.OCR_HTTP_API_KEY);
        return provider === "claude" ? new AiOcrProvider(reader) : new ManualOcrProvider();
      },
    },
  ],
})
export class OcrModule {}

@Module({ controllers: [EmailSignaturesController], providers: [EmailSignaturesService], exports: [EmailSignaturesService] })
export class EmailSignaturesModule {}

@Module({
  imports: [MailboxesModule, EmailSignaturesModule],
  controllers: [IntegrationsController],
  providers: [
    IntegrationsService,
    {
      provide: EMAIL_SENDER,
      inject: [ENV, MailboxesService],
      useFactory: (env: Env, mailboxes: MailboxesService) => {
        const smtp = new SmtpEmailSender(env.SMTP_URL, env.MAIL_FROM);
        return env.SYSTEM_MAILBOX ? new MailboxEmailSender(mailboxes, env.SYSTEM_MAILBOX, env.SYSTEM_MAIL_FROM, smtp) : smtp;
      },
    },
    {
      provide: WHATSAPP_SENDER,
      inject: [ENV],
      useFactory: (env: Env) => (env.WHATSAPP_PROVIDER === "meta_cloud" ? new MetaCloudWhatsApp(env.WHATSAPP_PHONE_NUMBER_ID!, env.WHATSAPP_ACCESS_TOKEN!) : new DisabledWhatsApp()),
    },
    { provide: SUBMISSION_CHANNEL, inject: [EMAIL_SENDER], useFactory: (email: EmailSender) => new EmailSubmissionChannel(email) },
  ],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}

// After IntegrationsModule: online signing emails links through it.
@Module({ imports: [DocumentsModule, IntegrationsModule], controllers: [FormsController, SigningController], providers: [FormsService, SigningService], exports: [FormsService, SigningService] })
export class FormsModule {}

@Module({
  imports: [FormsModule, DocumentsModule],
  controllers: [FlogasElectricityController, BordGaisElectricityController],
  providers: [ApplicationDocuments, FlogasElectricityService, BordGaisElectricityService],
})
export class SupplierApplicationsModule {}

@Module({ controllers: [ReportsController], providers: [ReportsService] })
export class ReportsModule {}

@Module({ controllers: [AdminController], providers: [AdminService, RetentionService], exports: [RetentionService] })
export class AdminModule {}

@Module({ providers: [AutomationsService, RenewalsService], exports: [AutomationsService, RenewalsService] })
export class AutomationsModule {}

/** "Needs your attention" on Home and the 07:30 morning summary. Rule-based (no AI). */
@Module({ imports: [OpportunitiesModule], controllers: [AttentionController], providers: [AttentionService], exports: [AttentionService] })
export class AttentionModule {}

@Module({ controllers: [HealthController] })
export class HealthModule {}

@Module({ controllers: [HelpController] })
export class HelpModule {}

export const FEATURE_MODULES = [
  CoreModule,
  DocumentsModule,
  OpportunitiesModule,
  CustomersModule,
  EnergyModule,
  MerchantModule,
  SignaturesModule,
  FormsModule,
  SupplierApplicationsModule,
  WorkflowsModule,
  AiModule,
  AssistantModule,
  OcrModule,
  IntegrationsModule,
  ReportsModule,
  AdminModule,
  AutomationsModule,
  AttentionModule,
  HealthModule,
  HelpModule,
  CallsModule,
  ChatModule,
  MailboxesModule,
  MigrationModule,
];
