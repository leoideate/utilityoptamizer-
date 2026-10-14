import { Global, Module } from "@nestjs/common";
import { ENV, type Env } from "../config/env";
import { CryptoService } from "../common/crypto.service";
import { FilesController } from "./files.controller";
import { LocalStorage, OBJECT_STORAGE, S3Storage } from "./storage";
import { ClamAvScanner, NoVirusScanner, VIRUS_SCANNER } from "./virus-scan";

@Global()
@Module({
  controllers: [FilesController],
  providers: [
    {
      provide: OBJECT_STORAGE,
      inject: [ENV, CryptoService],
      useFactory: (env: Env, crypto: CryptoService) =>
        env.STORAGE_DRIVER === "s3" ? new S3Storage(env) : new LocalStorage(env, crypto, `${env.WEB_ORIGIN}/api`),
    },
    {
      provide: VIRUS_SCANNER,
      inject: [ENV],
      useFactory: (env: Env) => (env.VIRUS_SCAN_DRIVER === "clamav" ? new ClamAvScanner(env.CLAMAV_HOST, env.CLAMAV_PORT) : new NoVirusScanner()),
    },
  ],
  exports: [OBJECT_STORAGE, VIRUS_SCANNER],
})
export class StorageModule {}
