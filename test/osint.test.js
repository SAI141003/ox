import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as osint from '../src/osint.js';

describe('OSINT Module Tests', () => {
  describe('searchEmail', () => {
    it('should return correct structure for valid email', async () => {
      const result = await osint.searchEmail('test@example.com');
      assert.ok(typeof result === 'object' && result !== null);
      assert.ok('ok' in result);
      assert.ok('data' in result);
      assert.ok('error' in result);
    });
  });

  describe('searchUsername', () => {
    it('should return correct structure for valid username', async () => {
      const result = await osint.searchUsername('testuser');
      assert.ok(typeof result === 'object' && result !== null);
      assert.ok('ok' in result);
      assert.ok('data' in result);
      assert.ok('error' in result);
      if (result.ok && result.data) {
        assert.ok('username' in result.data);
        assert.ok('platforms' in result.data);
        assert.ok('found' in result.data);
      }
    });
  });

  describe('searchDomain', () => {
    it('should return correct structure for valid domain', async () => {
      const result = await osint.searchDomain('example.com');
      assert.ok(typeof result === 'object' && result !== null);
      assert.ok('ok' in result);
      assert.ok('data' in result);
      assert.ok('error' in result);
      if (result.ok && result.data) {
        assert.ok('domain' in result.data);
        assert.ok('dns' in result.data);
        assert.ok('whois' in result.data);
        assert.ok('subdomains' in result.data);
      }
    });
  });

  describe('searchIP', () => {
    it('should return correct structure for valid IP', async () => {
      const result = await osint.searchIP('8.8.8.8');
      assert.ok(typeof result === 'object' && result !== null);
      assert.ok('ok' in result);
      assert.ok('data' in result);
      assert.ok('error' in result);
      if (result.ok && result.data) {
        assert.ok('ip' in result.data);
        assert.ok('abuseIPDB' in result.data);
        assert.ok('shodan' in result.data);
      }
    });
  });

  describe('searchBreach', () => {
    it('should return correct structure for valid email', async () => {
      const result = await osint.searchBreach('test@example.com');
      assert.ok(typeof result === 'object' && result !== null);
      assert.ok('ok' in result);
      assert.ok('data' in result);
      assert.ok('error' in result);
      if (result.ok && result.data) {
        assert.ok('email' in result.data);
        assert.ok('breaches' in result.data);
      }
    });
  });

  describe('searchShodan', () => {
    it('should return correct structure for valid query', async () => {
      const result = await osint.searchShodan('apache');
      assert.ok(typeof result === 'object' && result !== null);
      assert.ok('ok' in result);
      assert.ok('data' in result);
      assert.ok('error' in result);
      if (result.ok && result.data) {
        assert.ok('query' in result.data);
        assert.ok('results' in result.data);
      }
    });
  });

  describe('searchVirusTotal', () => {
    it('should return correct structure for valid target', async () => {
      const result = await osint.searchVirusTotal('example.com');
      assert.ok(typeof result === 'object' && result !== null);
      assert.ok('ok' in result);
      assert.ok('data' in result);
      assert.ok('error' in result);
      if (result.ok && result.data) {
        assert.ok('target' in result.data);
        assert.ok('verdict' in result.data);
      }
    });
  });

  describe('searchCensys', () => {
    it('should return correct structure for valid target', async () => {
      const result = await osint.searchCensys('example.com');
      assert.ok(typeof result === 'object' && result !== null);
      assert.ok('ok' in result);
      assert.ok('data' in result);
      assert.ok('error' in result);
      if (result.ok && result.data) {
        assert.ok('target' in result.data);
        assert.ok('results' in result.data);
      }
    });
  });

  describe('searchAbuseIPDB', () => {
    it('should return correct structure for valid IP', async () => {
      const result = await osint.searchAbuseIPDB('8.8.8.8');
      assert.ok(typeof result === 'object' && result !== null);
      assert.ok('ok' in result);
      assert.ok('data' in result);
      assert.ok('error' in result);
      if (result.ok && result.data) {
        assert.ok('ip' in result.data);
        assert.ok('abuseConfidenceScore' in result.data);
      }
    });
  });

  describe('searchGitHub', () => {
    it('should return correct structure for valid query', async () => {
      const result = await osint.searchGitHub('octocat');
      assert.ok(typeof result === 'object' && result !== null);
      assert.ok('ok' in result);
      assert.ok('data' in result);
      assert.ok('error' in result);
      if (result.ok && result.data) {
        assert.ok('query' in result.data);
        assert.ok('total' in result.data);
        assert.ok('users' in result.data);
      }
    });
  });

  describe('searchDNS', () => {
    it('should return correct structure for valid domain', async () => {
      const result = await osint.searchDNS('example.com');
      assert.ok(typeof result === 'object' && result !== null);
      assert.ok('ok' in result);
      assert.ok('data' in result);
      assert.ok('error' in result);
      if (result.ok && result.data) {
        assert.ok('domain' in result.data);
        assert.ok('records' in result.data);
        assert.ok('status' in result.data);
      }
    });
  });

  describe('generateDorks', () => {
    it('should return correct structure for valid query', () => {
      const result = osint.generateDorks('test');
      assert.ok(typeof result === 'object' && result !== null);
      assert.ok('ok' in result);
      assert.ok('data' in result);
      assert.ok('error' in result);
      if (result.ok && result.data) {
        assert.ok('query' in result.data);
        assert.ok('dorks' in result.data);
        assert.ok(Array.isArray(result.data.dorks));
        assert.ok(result.data.dorks.length > 0);
      }
    });
  });

  describe('searchFootprint', () => {
    it('should return correct structure for valid target', async () => {
      const result = await osint.searchFootprint('example.com');
      assert.ok(typeof result === 'object' && result !== null);
      assert.ok('ok' in result);
      assert.ok('data' in result);
      assert.ok('error' in result);
      if (result.ok && result.data) {
        assert.ok('target' in result.data);
        assert.ok('hasDNS' in result.data);
        assert.ok('githubUsers' in result.data);
        assert.ok('exposure' in result.data);
      }
    });
  });

  describe('searchPaste', () => {
    it('should return correct structure for valid query', () => {
      const result = osint.searchPaste('test');
      assert.ok(typeof result === 'object' && result !== null);
      assert.ok('ok' in result);
      assert.ok('data' in result);
      assert.ok('error' in result);
      if (result.ok && result.data) {
        assert.ok('query' in result.data);
        assert.ok('urls' in result.data);
        assert.ok(Array.isArray(result.data.urls));
        assert.ok(result.data.urls.length > 0);
      }
    });
  });

  describe('searchPhone', () => {
    it('should return correct structure for valid phone', async () => {
      const result = await osint.searchPhone('+15551234567');
      assert.ok(typeof result === 'object' && result !== null);
      assert.ok('ok' in result);
      assert.ok('data' in result);
      assert.ok('error' in result);
      if (result.ok && result.data) {
        assert.ok('phone' in result.data);
        assert.ok('data' in result.data);
      }
    });
  });

  describe('searchWhois', () => {
    it('should return correct structure for valid domain', async () => {
      const result = await osint.searchWhois('example.com');
      assert.ok(typeof result === 'object' && result !== null);
      assert.ok('ok' in result);
      assert.ok('data' in result);
      assert.ok('error' in result);
      if (result.ok && result.data) {
        assert.ok('domain' in result.data);
        assert.ok('whois' in result.data);
      }
    });
  });

  describe('searchSubdomain', () => {
    it('should return correct structure for valid domain', async () => {
      const result = await osint.searchSubdomain('example.com');
      assert.ok(typeof result === 'object' && result !== null);
      assert.ok('ok' in result);
      assert.ok('data' in result);
      assert.ok('error' in result);
      if (result.ok && result.data) {
        assert.ok('domain' in result.data);
        assert.ok('subdomains' in result.data);
        assert.ok('count' in result.data);
      }
    });
  });

  describe('searchURL', () => {
    it('should return correct structure for valid URL', async () => {
      const result = await osint.searchURL('https://example.com');
      assert.ok(typeof result === 'object' && result !== null);
      assert.ok('ok' in result);
      assert.ok('data' in result);
      assert.ok('error' in result);
      if (result.ok && result.data) {
        assert.ok('url' in result.data);
        assert.ok('status' in result.data);
        assert.ok('title' in result.data);
        assert.ok('contentType' in result.data);
        assert.ok('contentLength' in result.data);
        assert.ok('snippet' in result.data);
      }
    });
  });

  describe('sanctionsCheck', () => {
    it('should return correct structure for valid name', async () => {
      const result = await osint.sanctionsCheck('test');
      assert.ok(typeof result === 'object' && result !== null);
      assert.ok('ok' in result);
      assert.ok('data' in result);
      assert.ok('error' in result);
      if (result.ok && result.data) {
        assert.ok('name' in result.data);
        assert.ok('results' in result.data);
        assert.ok('found' in result.data);
      }
    });
  });

  describe('Return structure validation', () => {
    it('ok=true responses should have data and null error', async () => {
      const result = await osint.searchDNS('example.com');
      if (result.ok) {
        assert.ok(result.data !== null);
        assert.equal(result.error, null);
      }
    });

    it('ok=false responses should have null data and string error', async () => {
      const result = await osint.searchShodan('test');
      if (!result.ok) {
        assert.equal(result.data, null);
        assert.ok(typeof result.error === 'string');
      }
    });
  });
});
