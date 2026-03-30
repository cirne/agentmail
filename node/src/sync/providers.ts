// Provider abstraction — ADR-011

export interface ImapProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  syncFolder(folder: string, sinceDate: Date): Promise<void>;
}

// GmailProvider: syncs from [Gmail]/All Mail, uses X-GM-THRID + X-GM-LABELS
export class GmailProvider implements ImapProvider {
  async connect() {
    // TODO: connect via imapflow with app password or XOAUTH2
  }

  async disconnect() {
    // TODO
  }

  async syncFolder(_folder: string, _sinceDate: Date) {
    // TODO: UID SEARCH SINCE, fetch highest UIDs first
  }
}

// GenericImapProvider: standard IMAP, header-based threading
export class GenericImapProvider implements ImapProvider {
  async connect() {
    // TODO
  }

  async disconnect() {
    // TODO
  }

  async syncFolder(_folder: string, _sinceDate: Date) {
    // TODO
  }
}
