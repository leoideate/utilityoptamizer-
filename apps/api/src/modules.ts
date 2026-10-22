/**
 * Module wiring. Cross-cutting services (config, prisma, crypto, audit, notifications, storage,
 * job queue, opportunity access/stages, activities) are global; feature modules own their
 * services and controllers.
 */
import { Global, Module } from "@nestjs/common";
import { ENV, type Env } from "./config/env";
import { ActivitiesController } from "./activities/activities.controller";
import { ActivitiesService } from "./activities/activities.service";
import { AdminController } from "./admin/admin.controller";
import { AdminService } from "./admin/admin.service";
import { RetentionService } from "./admin/retention.service";
import { AuditService } from "./audit/audit.service";
import { CallsModule } from "./calls/calls.module";
import { ChatModule } from "./chat/chat.module";
import { AutomationsService } from "./automations/automations.service";
import { RenewalsService } from "./automations/renewals.service";
import { CustomersController } from "./customers/customers.controller";
import { CustomersService } from "./customers/customers.service";
import { DocumentsController } from "./documents/documents.controller";
import { DocumentsService } from "./documents/documents.service";
import { EnergyController } from "./energy/energy.controller";
import { EnergyService } from "./energy/energy.service";
import { HealthController } from "./health/health.controller";
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
import { MerchantController } from "./merchant/merchant.controller";
import { MerchantService } from "./merchant/merchant.service";
import { NotificationsService } from "./notifications/notifications.service";
import { OcrController } from "./ocr/ocr.controller";
import { OcrService } from "./ocr/ocr.service";
import { HttpOcrProvider, ManualOcrProvider, OCR_PROVIDER } from "./ocr/providers";
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

@Module({
  imports: [DocumentsModule],
  controllers: [LeadIntakeController, OpportunitiesController, ActivitiesController],
  providers: [OpportunitiesService, LeadIntakeService],
  exports: [OpportunitiesService],
})
export class OpportunitiesModule {}

@Module({ controllers: [CustomersController], providers: [CustomersService], exports: [CustomersService] })
export class CustomersModule {}

@Module({ controllers: [EnergyController], providers: [EnergyService] })
export class EnergyModule {}

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

@Module({
  imports: [CustomersModule, OpportunitiesModule],
  controllers: [OcrController],
  providers: [
    OcrService,
    {
      provide: OCR_PROVIDER,
      inject: [ENV],
      useFactory: (env: Env) => (env.OCR_PROVIDER === "http" ? new HttpOcrProvider(env.OCR_HTTP_ENDPOINT!, env.OCR_HTTP_API_KEY) : new ManualOcrProvider()),
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
    { provide: EMAIL_SENDER, inject: [ENV], useFactory: (env: Env) => new SmtpEmailSender(env.SMTP_URL, env.MAIL_FROM) },
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

@Module({ imports: [FormsModule, DocumentsModule], controllers: [FlogasElectricityController], providers: [FlogasElectricityService] })
export class SupplierApplicationsModule {}

@Module({ controllers: [ReportsController], providers: [ReportsService] })
export class ReportsModule {}

@Module({ controllers: [AdminController], providers: [AdminService, RetentionService], exports: [RetentionService] })
export class AdminModule {}

@Module({ providers: [AutomationsService, RenewalsService], exports: [AutomationsService, RenewalsService] })
export class AutomationsModule {}

@Module({ controllers: [HealthController] })
export class HealthModule {}

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
  OcrModule,
  IntegrationsModule,
  ReportsModule,
  AdminModule,
  AutomationsModule,
  HealthModule,
  CallsModule,
  ChatModule,
  MailboxesModule,
];
