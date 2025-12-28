# Security Policy

## Supported Versions

We actively support the following versions of homebridge-plugin-klares4:

| Version | Supported          |
| ------- | ------------------ |
| 1.1.x   | :white_check_mark: |
| 1.0.x   | :x:                |
| < 1.0   | :x:                |

## Reporting a Vulnerability

We take security vulnerabilities seriously. If you discover a security vulnerability in homebridge-plugin-klares4, please report it responsibly.

### Private Reporting

Please **DO NOT** create a public GitHub issue for security vulnerabilities. Instead:

1. **Email**: Send details to [paolo.trivisonno@gmail.com](mailto:paolo.trivisonno@gmail.com)
2. **Subject**: Include "SECURITY" in the email subject
3. **Details**: Provide detailed information about the vulnerability

### What to Include

When reporting a vulnerability, please include:

- Description of the vulnerability
- Steps to reproduce the issue
- Potential impact assessment
- Suggested fix (if available)
- Your contact information

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial Assessment**: Within 5 business days
- **Status Updates**: Weekly until resolved
- **Fix Timeline**: Depends on severity (critical issues prioritized)

### Security Considerations

This plugin handles:
- WebSocket connections to Ksenia Lares4 systems
- Home automation device control
- Network communication protocols

Please be especially vigilant about vulnerabilities related to:
- Authentication bypass
- Command injection
- Network protocol vulnerabilities
- Data exposure risks

## Security Best Practices

When using this plugin:

1. **Network Security**: Ensure your Homebridge instance runs on a secure network
2. **Updates**: Keep the plugin updated to the latest version
3. **Access Control**: Limit access to your Homebridge configuration
4. **Monitoring**: Monitor logs for unusual activity

## Disclosure Policy

- We will coordinate disclosure timing with the reporter
- Security fixes will be released as soon as possible
- Credit will be given to reporters (unless anonymity is requested)
- Security advisories will be published after fixes are available

Thank you for helping keep homebridge-plugin-klares4 secure!