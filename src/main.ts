import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get<ConfigService>(ConfigService);
  app.enableCors({
    origin: configService.getOrThrow('ORIGIN'),
    credentials: true,
  });

  await app.listen(configService.getOrThrow('PORT'), '0.0.0.0');
}
bootstrap();
