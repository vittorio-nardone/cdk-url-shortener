import * as crypto from 'crypto';
import { aws_dynamodb as Dynamodb } from 'aws-cdk-lib';

export const hash = (code: string): string =>
  crypto.createHash('md5').update(code).digest('hex').substr(0, 6);

export const getKeySchemaProperty = (
  table: Dynamodb.Table,
  keyType: string,
): Dynamodb.CfnTable.KeySchemaProperty => {
  const cfnTable = table.node.defaultChild as Dynamodb.CfnTable;
  const keySchemas = cfnTable.keySchema as Dynamodb.CfnTable.KeySchemaProperty[];
  const partitionKeyAttribute = keySchemas.find(
    (keySchema) => keySchema.keyType === keyType,
  );
  if (partitionKeyAttribute === undefined) {
    throw new Error('PartitionKey is not set');
  }
  return partitionKeyAttribute;
};
