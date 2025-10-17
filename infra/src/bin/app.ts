import * as cdk from "aws-cdk-lib";
import { CoreStack } from "../../lib/core-stack";
import { AppStack } from "../../lib/app-stack";

const app = new cdk.App();
const core = new CoreStack(app, "CoreStack", {});
new AppStack(app, "AppStack", {
  coreResources: {
    rawBucketName: core.rawBucket.bucketName,
    reportsBucketName: core.reportsBucket.bucketName,
    glueDatabaseName: core.glueDatabaseName,
    athenaWorkGroupName: core.athenaWorkGroupName,
  },
});


