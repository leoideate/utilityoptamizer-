import { Global, Module } from "@nestjs/common";
import { ENV, type Env, loadEnv } from "./env";

@Global()
@Module({
  providers: [{ provide: ENV, useFactory: (): Env => loadEnv() }],
  exports: [ENV],
})
export class ConfigModule {}
