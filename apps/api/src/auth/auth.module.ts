import { Global, Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { SsoController } from "./sso.controller";
import { SsoService } from "./sso.service";

@Global()
@Module({
  controllers: [AuthController, SsoController],
  providers: [AuthService, SsoService],
  exports: [AuthService, SsoService],
})
export class AuthModule {}
