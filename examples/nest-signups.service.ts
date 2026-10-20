// signups.service.ts: a NestJS service with TypeORM.
// npm install @bydtech/fallback-journal
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { createJournal, type SaveMeta } from '@bydtech/fallback-journal';
import { SignupEntity } from './signup.entity'; // has a uuid primary key `id` and an `email` column

interface Signup {
  email: string;
}

@Injectable()
export class SignupsService implements OnApplicationBootstrap {
  private readonly log = new Logger(SignupsService.name);

  private readonly journal = createJournal<Signup>({
    file: process.env.SIGNUPS_JOURNAL ?? 'storage/signups.ndjson',
    onQueued: (entry, error) => this.log.warn(`Signup ${entry.id} kept on disk, not in the database: ${String(error)}`),
    onDrained: (result) => this.log.log(`Replayed ${result.saved} signup(s); ${result.remaining} still waiting.`),
  });

  constructor(@InjectRepository(SignupEntity) private readonly signups: Repository<SignupEntity>) {}

  // Upsert on the journal's id: a replay never inserts twice.
  private readonly insert = async (signup: Signup, { id }: SaveMeta) => {
    await this.signups.upsert({ id, ...signup }, ['id']);
  };

  async create(signup: Signup) {
    const result = await this.journal.save(signup, this.insert);
    return { received: true, storedIn: result.saved ? 'database' : 'journal' };
  }

  // Records left from before a restart go in once the app is up, without
  // holding up the boot if the database is still away.
  onApplicationBootstrap() {
    this.journal.drain(this.insert).catch((error: unknown) => this.log.error(`Replay failed: ${String(error)}`));
  }

  health() {
    return { signupsWaiting: this.journal.size() };
  }
}
