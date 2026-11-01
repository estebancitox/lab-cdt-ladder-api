import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PRICE_USD_PER_MTOK } from './eval/suite'
import { limitReached } from './response'
import { SPEC_MD } from './test-support/contract'

/**
 * template.yaml against SPEC §8.2 and against the code it configures. The template is read as
 * text: no YAML parser is a dependency, and every value checked here is a literal on its own
 * line, so a regex per block is enough and a change of shape fails loudly.
 */
const TEMPLATE = readFileSync(new URL('../template.yaml', import.meta.url), 'utf8')

/** The lines under `name:` at `indent` spaces, up to the next key at that indent or shallower. */
function block(name: string, indent = 2): string {
  const pad = ' '.repeat(indent)
  const m = new RegExp(`^${pad}${name}:\\n((?:(?!^ {0,${indent}}\\S).*\\n?)*)`, 'm').exec(TEMPLATE)
  if (!m) throw new Error(`no block ${name} at indent ${indent} in template.yaml`)
  return m[1]
}

/** The items of the YAML list under `key` inside `text`. */
function list(text: string, key: string): string[] {
  const m = new RegExp(`^(\\s+)${key}:\\n((?:\\1  - .*\\n)+)`, 'm').exec(text)
  if (!m) throw new Error(`no list ${key}`)
  return m[2]
    .trim()
    .split('\n')
    .map((line) => line.trim().replace(/^- /, ''))
}

describe('the public URL (SPEC §8.2, decision F6)', () => {
  it('UrlAuthType is AWS_IAM or NONE, defaults to AWS_IAM, and is what the URL takes', () => {
    const parameter = block('UrlAuthType')
    expect(parameter).toMatch(/^    Default: AWS_IAM$/m)
    expect(list(parameter, 'AllowedValues')).toEqual(['AWS_IAM', 'NONE'])
    expect(TEMPLATE).toMatch(/^        AuthType: !Ref UrlAuthType$/m)
    expect(TEMPLATE).toMatch(/^  UrlIsPublic: !Equals \[!Ref UrlAuthType, NONE\]$/m)
  })

  it('the two permissions a public URL needs exist only while it is public, as SAM would write them', () => {
    const url = block('PublicUrlInvokePermission')
    expect(url).toMatch(/^    Condition: UrlIsPublic$/m)
    expect(url).toMatch(/^      Action: lambda:InvokeFunctionUrl$/m)
    expect(url).toMatch(/^      FunctionName: !Ref ExplainFunction$/m)
    expect(url).toMatch(/^      Principal: '\*'$/m)
    expect(url).toMatch(/^      FunctionUrlAuthType: NONE$/m)
    const fn = block('PublicFunctionInvokePermission')
    expect(fn).toMatch(/^    Condition: UrlIsPublic$/m)
    expect(fn).toMatch(/^      Action: lambda:InvokeFunction$/m)
    expect(fn).toMatch(/^      FunctionName: !Ref ExplainFunction$/m)
    expect(fn).toMatch(/^      Principal: '\*'$/m)
    expect(fn).toMatch(/^      InvokedViaFunctionUrl: true$/m)
    expect(TEMPLATE.match(/Condition: UrlIsPublic/g)).toHaveLength(2)
    expect(TEMPLATE.match(/Type: AWS::Lambda::Permission/g)).toHaveLength(2)
  })

  it('Cors: the two origins, POST, content-type, MaxAge 600, and exactly the 429 header exposed', () => {
    const cors = block('Cors', 8)
    expect(list(cors, 'AllowOrigins')).toEqual([
      'https://estebancitox.github.io',
      'http://localhost:5173',
    ])
    expect(list(cors, 'AllowMethods')).toEqual(['POST'])
    expect(list(cors, 'AllowHeaders')).toEqual(['content-type'])
    expect(cors).toMatch(/^          MaxAge: 600$/m)
    expect(cors).not.toContain('AllowCredentials')
    // What a browser may read of a 429 beyond the CORS-safelisted headers: the one header the
    // response sets that json() does not.
    const own = Object.keys(limitReached('ip', 30).headers).filter(
      (name) => !['content-type', 'cache-control'].includes(name),
    )
    expect(own).toEqual(['retry-after'])
    expect(list(cors, 'ExposeHeaders')).toEqual(own)
  })

  it('the description and the FunctionUrl output no longer call the URL private', () => {
    const description = /^Description: >-\n((?:  .*\n)+)/m.exec(TEMPLATE)?.[1]
    if (!description) throw new Error('no Description in template.yaml')
    expect(description).not.toMatch(/private/i)
    expect(block('FunctionUrl')).not.toMatch(/private/i)
    expect(block('FunctionUrl')).toContain('Public when UrlAuthType is NONE')
  })
})

describe('the daily caps (SPEC §8.2, decisions F1, F2, F9)', () => {
  it('are parameters with the §8.2 defaults, handed to the code as environment variables', () => {
    expect(block('DailyRequestLimit')).toMatch(/^    Default: 100$/m)
    expect(block('DailyRequestLimit')).toMatch(/^    MinValue: 1$/m)
    expect(block('IpDailyRequestLimit')).toMatch(/^    Default: 10$/m)
    expect(block('IpDailyRequestLimit')).toMatch(/^    MinValue: 1$/m)
    const variables = block('Variables', 8)
    expect(variables).toMatch(/^          LIMITS_TABLE: !Ref LimitsTable$/m)
    expect(variables).toMatch(/^          DAILY_LIMIT: !Ref DailyRequestLimit$/m)
    expect(variables).toMatch(/^          IP_DAILY_LIMIT: !Ref IpDailyRequestLimit$/m)
  })

  it('the table is on demand, keyed by pk, with TTL on expiresAt, the attribute the code sets', () => {
    const table = block('LimitsTable')
    expect(table).toMatch(/^    Type: AWS::DynamoDB::Table$/m)
    expect(table).toMatch(/^      BillingMode: PAY_PER_REQUEST$/m)
    expect(table).toMatch(/^        - AttributeName: pk\n          AttributeType: S$/m)
    expect(table).toMatch(/^        - AttributeName: pk\n          KeyType: HASH$/m)
    expect(table).toMatch(/^        AttributeName: expiresAt\n        Enabled: true$/m)
    expect(table).not.toContain('RANGE')
  })

  it('the function may UpdateItem on that table, and nothing else of DynamoDB', () => {
    expect(TEMPLATE).toMatch(
      /^            - Effect: Allow\n              Action: dynamodb:UpdateItem\n              Resource: !GetAtt LimitsTable\.Arn$/m,
    )
    expect(TEMPLATE.match(/dynamodb:\w+/g)).toEqual(['dynamodb:UpdateItem'])
    expect(TEMPLATE.match(/ssm:\w+/g)).toEqual(['ssm:GetParameter'])
  })

  it('the §8 rows that bound spend are unchanged: concurrency 2 and the 25 s timeout', () => {
    expect(TEMPLATE).toMatch(/^      ReservedConcurrentExecutions: 2$/m)
    expect(TEMPLATE).toMatch(/^      Timeout: 25$/m)
  })
})

describe('the spend alarm (SPEC §8.2, decision F7)', () => {
  it('two filters read the §8.4 token fields of the log line, one metric each', () => {
    for (const [field, metric] of [
      ['inputTokens', 'InputTokens'],
      ['outputTokens', 'OutputTokens'],
    ]) {
      const filter = block(`${metric}MetricFilter`)
      expect(filter).toMatch(/^    Type: AWS::Logs::MetricFilter$/m)
      expect(filter).toMatch(/^      LogGroupName: !Ref ExplainLogGroup$/m)
      expect(filter).toContain(`FilterPattern: '{ $.${field} >= 0 }'`)
      expect(filter).toContain(`MetricValue: $.${field}`)
      expect(filter).toContain(`MetricName: ${metric}`)
      expect(filter).toMatch(/^        - MetricNamespace: !Ref AWS::StackName$/m)
      expect(filter.match(/MetricName:/g)).toHaveLength(1)
    }
    // The fields are the ones SPEC §8.4 names, so the alarm inherits their lower bound.
    expect(SPEC_MD).toMatch(/^- `inputTokens` and `outputTokens`, present when a model call returned usage/m)
  })

  it('the alarm prices the sums as the harness does, over a sliding day, against DailySpendAlarmUsd', () => {
    const alarm = block('DailySpendAlarm')
    expect(alarm).toMatch(/^    Type: AWS::CloudWatch::Alarm$/m)
    expect(alarm).toMatch(/^      AlarmName: !Sub \$\{AWS::StackName\}-daily-spend$/m)
    const expression = /Expression: \(inputTokens \* (\d+) \+ outputTokens \* (\d+)\) \/ 1000000$/m.exec(alarm)
    if (!expression) throw new Error('no spend expression in the alarm')
    expect([Number(expression[1]), Number(expression[2])]).toEqual([
      PRICE_USD_PER_MTOK.input,
      PRICE_USD_PER_MTOK.output,
    ])
    expect(alarm.match(/Period: 86400/g)).toHaveLength(2)
    expect(alarm.match(/Stat: Sum/g)).toHaveLength(2)
    expect(alarm.match(/MetricName: (InputTokens|OutputTokens)/g)).toEqual([
      'MetricName: InputTokens',
      'MetricName: OutputTokens',
    ])
    expect(alarm).toMatch(/^      ComparisonOperator: GreaterThanOrEqualToThreshold$/m)
    expect(alarm).toMatch(/^      Threshold: !Ref DailySpendAlarmUsd$/m)
    expect(alarm).toMatch(/^      EvaluationPeriods: 1$/m)
    expect(alarm).toMatch(/^      TreatMissingData: notBreaching$/m)
    expect(list(alarm, 'AlarmActions')).toEqual(['!Ref SpendAlarmTopic'])
    expect(block('DailySpendAlarmUsd')).toMatch(/^    Default: 0\.5$/m)
  })

  it('the topic has no subscription, and the template holds no address', () => {
    expect(block('SpendAlarmTopic')).toBe('    Type: AWS::SNS::Topic\n\n')
    expect(TEMPLATE).not.toContain('@')
    expect(block('SpendAlarmTopicArn')).toMatch(/^    Value: !Ref SpendAlarmTopic$/m)
    expect(block('SpendAlarmName')).toMatch(/^    Value: !Ref DailySpendAlarm$/m)
    expect(block('LimitsTableName')).toMatch(/^    Value: !Ref LimitsTable$/m)
  })
})
